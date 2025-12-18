/**
 * Voice Satellite Card
 * 
 * A Home Assistant Custom Card that implements a local voice satellite using OpenWakeWord.
 * It performs wake word detection in the browser using ONNX Runtime Web and streams audio
 * to Home Assistant's Assist Pipeline for speech-to-text and intent recognition.
 */
class VoiceSatelliteCard extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._initialized = false;
        this._hass = null;
        this._config = {};
        
        // State
        this.isListening = false;
        this.currentState = 'idle';
        this.models = {}; // Will be populated in loadModels based on config
        this.wakeWord = 'ok_nabu'; // Default
        this.pipelineId = undefined; // Default to HA default
        
        // Audio Context
        this.audioContext = null;
        this.workletNode = null;
        this.mediaStream = null;
        
        // Pipeline
        this.mel_buffer = [];
        this.embedding_buffer = [];
        this.vadState = { h: null, c: null };
        this.isSpeechActive = false;
        this.vadHangoverCounter = 0;
        this.isDetectionCoolingDown = false;
        
        // HA Connection
        this.haConnection = null;
        this.haPipelineId = null;
        this.isPlayingTTS = false;
        
        // Constants
        this.SAMPLE_RATE = 16000;
        this.FRAME_SIZE = 1280;
        this.VAD_HANGOVER_FRAMES = 12;
    }

    /**
     * Sets the configuration for the card.
     * Called by Home Assistant when the card is initialized or configuration changes.
     * @param {Object} config - The configuration object.
     */
    setConfig(config) {
        this._config = config;
        this.wakeWord = config.wake_word || 'ok_nabu';
        this.pipelineId = config.pipeline;
    }

    /**
     * Sets the Home Assistant object.
     * Called by Home Assistant when the connection state changes.
     * @param {Object} hass - The Home Assistant object.
     */
    set hass(hass) {
        this._hass = hass;
        if (!this._initialized && hass) {
            this.init();
        }
    }

    /**
     * Initializes the card, loads resources, and connects to Home Assistant.
     */
    async init() {
        try {
            this._initialized = true;
            this.render();
            this.loadStyles();
            
            // Load ORT if not present
            if (!window.ort) {
                await this.loadScript('/local/voice-satellite-card/ort.wasm.min.js');
            }
            
            // Configure WASM paths for ONNX Runtime
            ort.env.wasm.wasmPaths = "/local/voice-satellite-card/";

            // Initialize HA Connection (Dedicated)
            this.initHAConnection();

            // Load Models
            this.loadModels();
        } catch (e) {
            this.log(`Initialization failed: ${e.message}`, 'error');
            console.error("Initialization failed:", e);
            this.setStatus('Initialization Failed', 'error');
            const btn = this.shadowRoot.getElementById('start-button');
            if(btn) {
                btn.textContent = 'ERROR';
                btn.disabled = true;
            }
        }
    }
    
    loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    initHAConnection() {
        if (this.haConnection) return; // Prevent multiple connections
        // We use a dedicated connection to avoid interfering with the main HA connection
        // and to have full control over binary messages.
        const auth = this._hass.auth;
        const url = auth.data.hassUrl || window.location.origin;
        this.haConnection = new HAConnection(url, auth.data.access_token);
        this.haConnection.connect().then(() => {
            this.log('Connected to HA Voice Satellite', 'system');
        }).catch(e => {
            this.log(`HA Connection Failed: ${e}`, 'error');
        });
    }

    /**
     * Loads the ONNX models for wake word detection, embedding, and VAD.
     * Uses the configured wake word model.
     */
    async loadModels() {
        const btn = this.shadowRoot.getElementById('start-button');
        btn.textContent = 'Loading models...';
        btn.disabled = true;
        
        const sessionOptions = { executionProviders: ['wasm'] };
        try {
            const basePath = '/local/voice-satellite-card/models/';
            
            // Determine model file based on configuration
            let modelFile = 'ok_nabu.onnx';
            if (this.wakeWord === 'alexa') modelFile = 'alexa_v0.1.onnx'; // Note: alexa model might not be available in the provided context
            else if (this.wakeWord === 'hey_jarvis') modelFile = 'hey_jarvis_v0.1.onnx';
            else if (this.wakeWord === 'hey_rhasspy') modelFile = 'hey_rhasspy_v0.1.onnx';
            else if (this.wakeWord === 'ok_nabu') modelFile = 'ok_nabu.onnx';
            else if (this.wakeWord === 'nexoos') modelFile = 'nexoos.onnx';
            
            this.models = {
                [this.wakeWord]: { 
                    url: basePath + modelFile, 
                    session: null, 
                    scores: new Array(50).fill(0) 
                }
            };

            [this.melspecModel, this.embeddingModel, this.vadModel] = await Promise.all([
                ort.InferenceSession.create(basePath + 'melspectrogram.onnx', sessionOptions),
                ort.InferenceSession.create(basePath + 'embedding_model.onnx', sessionOptions),
                ort.InferenceSession.create(basePath + 'silero_vad.onnx', sessionOptions)
            ]);
            
            for (const name in this.models) {
                this.models[name].session = await ort.InferenceSession.create(this.models[name].url, sessionOptions);
            }
            
            this.log('Models loaded', 'system');
            btn.disabled = false;
            btn.textContent = 'Start Listening';
        } catch(e) {
            this.log(`Model loading failed: ${e.message}`, 'error');
            console.error(e);
        }
    }

    render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                }
                .card {
                    background-color: var(--ha-card-background, var(--card-background-color, white));
                    border-radius: var(--ha-card-border-radius, 4px);
                    box-shadow: var(--ha-card-box-shadow, 0px 2px 1px -1px rgba(0,0,0,0.2), 0px 1px 1px 0px rgba(0,0,0,0.14), 0px 1px 3px 0px rgba(0,0,0,0.12));
                    padding: 16px;
                    text-align: center;
                    color: var(--primary-text-color);
                }
                .status-icon {
                    width: 100px;
                    height: 100px;
                    border-radius: 50%;
                    object-fit: cover;
                    border: 4px solid var(--divider-color, #e0e0e0);
                    transition: border-color 0.2s ease-in-out;
                    margin: 16px auto;
                    display: block;
                }
                .status-text {
                    font-size: 1.2rem;
                    margin-bottom: 16px;
                    font-style: italic;
                    min-height: 1.5em;
                }
                button {
                    background-color: var(--primary-color);
                    color: var(--text-primary-color);
                    border: none;
                    padding: 10px 20px;
                    border-radius: 4px;
                    font-size: 1rem;
                    cursor: pointer;
                    width: 100%;
                    margin-top: 8px;
                }
                button:disabled {
                    background-color: var(--disabled-text-color);
                    cursor: not-allowed;
                }
                .debug-log {
                    margin-top: 16px;
                    text-align: left;
                    background: var(--secondary-background-color);
                    padding: 8px;
                    border-radius: 4px;
                    font-family: monospace;
                    font-size: 0.8rem;
                    max-height: 150px;
                    overflow-y: auto;
                    display: none;
                }
                .log-entry { margin-bottom: 4px; border-bottom: 1px solid var(--divider-color); }
                .log-entry.user { color: var(--primary-color); font-weight: bold; }
                .log-entry.assistant { color: var(--primary-text-color); }
                .log-entry.error { color: var(--error-color); }
            </style>
            <div class="card">
                <h2>Voice Satellite</h2>
                <img id="status-icon" class="status-icon" src="/local/voice-satellite-card/assets/idle.jpg">
                <div id="status-text" class="status-text">Ready</div>
                
                <button id="start-button">Start Listening</button>
                <button id="stop-button" style="display:none">Stop</button>
                
                <div style="margin-top: 10px;">
                    <label>
                        <input type="checkbox" id="debug-toggle"> Show Debug Log
                    </label>
                </div>
                
                <div id="debug-log" class="debug-log"></div>
            </div>
        `;
        
        this.shadowRoot.getElementById('start-button').addEventListener('click', () => this.startListening());
        this.shadowRoot.getElementById('stop-button').addEventListener('click', () => this.stopListening());
        
        const debugToggle = this.shadowRoot.getElementById('debug-toggle');
        const debugLog = this.shadowRoot.getElementById('debug-log');
        debugToggle.addEventListener('change', (e) => {
            debugLog.style.display = e.target.checked ? 'block' : 'none';
            if (!e.target.checked) debugLog.innerHTML = '';
        });
    }
    
    loadStyles() {
        // Styles are in render()
    }

    log(message, type = 'system') {
        const debugToggle = this.shadowRoot.getElementById('debug-toggle');
        if (!debugToggle.checked) return;
        
        const debugLog = this.shadowRoot.getElementById('debug-log');
        const div = document.createElement('div');
        div.className = `log-entry ${type}`;
        div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        debugLog.appendChild(div);
        debugLog.scrollTop = debugLog.scrollHeight;
    }

    setStatus(status, state) {
        this.shadowRoot.getElementById('status-text').textContent = status;
        let iconName = 'idle.jpg';
        if (state === 'listening') iconName = 'listening.jpg';
        else if (state === 'speaking') iconName = 'speaking.jpg';
        else if (state === 'processing') iconName = 'processing.jpg';
        else if (state === 'recording') iconName = 'recording.jpg';
        else if (state === 'error') iconName = 'error.jpg';
        
        this.shadowRoot.getElementById('status-icon').src = `/local/voice-satellite-card/assets/${iconName}`;
    }

    // --- Audio Logic (Copied & Adapted from app.js) ---
    
    resetState() {
        this.mel_buffer = [];
        this.embedding_buffer = [];
        for (let i = 0; i < 16; i++) {
            this.embedding_buffer.push(new Float32Array(96).fill(0));
        }
        const vadStateShape = [2, 1, 64];
        if (!this.vadState.h) {
            this.vadState.h = new ort.Tensor('float32', new Float32Array(128).fill(0), vadStateShape);
            this.vadState.c = new ort.Tensor('float32', new Float32Array(128).fill(0), vadStateShape);
        } else {
            this.vadState.h.data.fill(0);
            this.vadState.c.data.fill(0);
        }
        this.isSpeechActive = false;
        this.vadHangoverCounter = 0;
        this.isDetectionCoolingDown = false;
        for (const name in this.models) { this.models[name].scores.fill(0); }
    }

    /**
     * Starts the microphone and audio processing.
     * Initializes the AudioContext, AudioWorklet, and starts the VAD/Wake Word loop.
     */
    async startListening() {
        if (this.isListening) return;
        
        const startBtn = this.shadowRoot.getElementById('start-button');
        startBtn.disabled = true;
        startBtn.textContent = 'Starting...';
        
        this.resetState();
        
        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
            });
            
            this.audioContext = new AudioContext({ sampleRate: this.SAMPLE_RATE });
            const source = this.audioContext.createMediaStreamSource(this.mediaStream);
            
            // AudioWorklet
            const audioProcessorCode = `
                class AudioProcessor extends AudioWorkletProcessor {
                    bufferSize = 1280;
                    _buffer = new Float32Array(this.bufferSize);
                    _pos = 0;
                    constructor() { super(); }
                    process(inputs) {
                        const input = inputs[0][0];
                        if (input) {
                            for (let i = 0; i < input.length; i++) {
                                this._buffer[this._pos++] = input[i];
                                if (this._pos === this.bufferSize) {
                                    this.port.postMessage(this._buffer);
                                    this._pos = 0;
                                }
                            }
                        }
                        return true;
                    }
                }
                registerProcessor('audio-processor', AudioProcessor);
            `;
            const blob = new Blob([audioProcessorCode], { type: 'application/javascript' });
            const workletURL = URL.createObjectURL(blob);
            await this.audioContext.audioWorklet.addModule(workletURL);
            
            this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor');
            this.workletNode.port.onmessage = async (event) => {
                const chunk = event.data;
                if (!chunk) return;

                if (this.currentState === 'listening_ww') {
                    // Update VAD state first to provide immediate feedback
                    const vadFired = await this.runVad(chunk);
                    const wasSpeechActive = this.isSpeechActive;
                    
                    if (vadFired) {
                        this.isSpeechActive = true;
                        this.vadHangoverCounter = this.VAD_HANGOVER_FRAMES;
                        if (!wasSpeechActive) {
                            this.setSpeakingIndicator(true); // Start yellow border
                        }
                    } else if (this.vadHangoverCounter > 0) this.vadHangoverCounter--;
                    this.isSpeechActive = this.vadHangoverCounter > 0;

                    // Run inference for wake word
                    await this.runInference(chunk);

                    if (wasSpeechActive && !this.isSpeechActive) {
                        this.setSpeakingIndicator(false); // Stop yellow border
                    }
                } else if (this.currentState === 'assist_active') {
                    if (this.haConnection && this.haPipelineId) {
                        const pcm16 = this.floatTo16BitPCM(chunk);
                        this.haConnection.sendAudioChunk(this.haPipelineId, pcm16);
                    }
                }
            };
            
            source.connect(this.workletNode);
            this.workletNode.connect(this.audioContext.destination);
            
            this.isListening = true;
            startBtn.style.display = 'none';
            const stopBtn = this.shadowRoot.getElementById('stop-button');
            stopBtn.style.display = 'block';
            
            this.currentState = 'listening_ww';
        this.setStatus(`Listening for "${this.wakeWord}"`, 'listening');
        this.log('Microphone started', 'system');
            
        } catch (err) {
            console.error(err);
            this.log(`Error: ${err.message}`, 'error');
            this.stopListening();
        }
    }

    stopListening() {
        if (this.isListening) {
            if (this.mediaStream) this.mediaStream.getTracks().forEach(track => track.stop());
            if (this.workletNode) { this.workletNode.port.onmessage = null; this.workletNode.disconnect(); this.workletNode = null; }
            if (this.audioContext && this.audioContext.state !== 'closed') this.audioContext.close();
            this.isListening = false;
        }
        const startBtn = this.shadowRoot.getElementById('start-button');
        startBtn.textContent = 'Start Listening';
        startBtn.disabled = false;
        startBtn.style.display = 'block';
        this.shadowRoot.getElementById('stop-button').style.display = 'none';
        
        this.currentState = 'idle';
        this.setStatus('Stopped', 'idle');
    }

    /**
     * Runs Voice Activity Detection (VAD) on a chunk of audio.
     * @param {Float32Array} chunk - The audio chunk.
     * @returns {Promise<boolean>} - True if speech is detected.
     */
    async runVad(chunk) {
        try {
            const tensor = new ort.Tensor('float32', chunk, [1, chunk.length]);
            const sr = new ort.Tensor('int64', [BigInt(this.SAMPLE_RATE)], []);
            const res = await this.vadModel.run({ input: tensor, sr: sr, h: this.vadState.h, c: this.vadState.c });
            this.vadState.h = res.hn; this.vadState.c = res.cn;
            return res.output.data[0] > 0.5;
        } catch (err) { console.error("VAD Error:", err); return false; }
    }

    /**
     * Runs the wake word inference pipeline (Mel Spectrogram -> Embedding -> Classifier).
     * @param {Float32Array} chunk - The audio chunk.
     */
    async runInference(chunk) {
        const melspecTensor = new ort.Tensor('float32', chunk, [1, this.FRAME_SIZE]);
        const melspecResults = await this.melspecModel.run({ [this.melspecModel.inputNames[0]]: melspecTensor });
        let new_mel_data = melspecResults[this.melspecModel.outputNames[0]].data;
        
        for (let j = 0; j < new_mel_data.length; j++) { new_mel_data[j] = (new_mel_data[j] / 10.0) + 2.0; }
        for (let j = 0; j < 5; j++) {
            this.mel_buffer.push(new Float32Array(new_mel_data.subarray(j * 32, (j + 1) * 32))); 
        }

        while (this.mel_buffer.length >= 76) {
            const window_frames = this.mel_buffer.slice(0, 76);
            const flattened_mel = new Float32Array(76 * 32);
            for (let j = 0; j < window_frames.length; j++) { flattened_mel.set(window_frames[j], j * 32); }

            const embeddingFeeds = { [this.embeddingModel.inputNames[0]]: new ort.Tensor('float32', flattened_mel, [1, 76, 32, 1]) };
            const embeddingOut = await this.embeddingModel.run(embeddingFeeds);
            const new_embedding = embeddingOut[this.embeddingModel.outputNames[0]].data;

            this.embedding_buffer.shift();
            this.embedding_buffer.push(new Float32Array(new_embedding));

            const flattened_embeddings = new Float32Array(16 * 96);
            for (let j = 0; j < this.embedding_buffer.length; j++) { flattened_embeddings.set(this.embedding_buffer[j], j * 96); }
            const final_input_tensor = new ort.Tensor('float32', flattened_embeddings, [1, 16, 96]);

            for (const name in this.models) {
                const results = await this.models[name].session.run({ [this.models[name].session.inputNames[0]]: final_input_tensor });
                const score = results[this.models[name].session.outputNames[0]].data[0];
                
                if (score > 0.5 && this.isSpeechActive && !this.isDetectionCoolingDown) {
                    this.log(`Wake Word Detected: ${name} (${score.toFixed(2)})`, 'system');
                    this.isDetectionCoolingDown = true;
                    this.signalVisualFeedback('green'); // Segnale verde per wakeword
                    this.switchToAssist();
                    setTimeout(() => { this.isDetectionCoolingDown = false; }, 2000);
                } else if (score > 0.3 && this.isSpeechActive && !this.isDetectionCoolingDown) {
                    // Wake word "near miss" - provide visual feedback
                    this.log(`Near miss for wake word: ${name} (${score.toFixed(2)})`, 'system');
                    this.signalVisualFeedback('orange'); // Segnale arancione per "near miss"
                }
            }
            this.mel_buffer.splice(0, 8);
        }
    }

    /**
     * Switches the state to 'assist_active' and starts the Home Assistant Assist Pipeline.
     */
    async switchToAssist() {
        this.currentState = 'assist_active';
        this.playBeep(); // Spostato qui per suonare dopo il segnale verde
        this.setStatus('Speaking to Home Assistant', 'recording');
        const options = { sample_rate: this.SAMPLE_RATE };
        if (this.pipelineId) {
            options.pipeline_id = this.pipelineId;
        }
        // Wait for the pipeline to be confirmed by HA before proceeding
        const { handlerId, requestId } = await this.haConnection.runAssistPipeline('stt', 'tts', options);
        this.haPipelineId = handlerId; // The ID for sending audio chunks
        this.log(`Pipeline opened with handler ID: ${handlerId} (Request ID: ${requestId})`, 'system');
        if (handlerId) {
            // The event listener is keyed by the request ID
            this.haConnection.eventListeners.set(requestId, (event) => this.handlePipelineEvent(event));
        }
    }

    /**
     * Handles events received from the Home Assistant Assist Pipeline.
     * @param {Object} event - The pipeline event.
     */
    handlePipelineEvent(event) {
        switch (event.type) {
            case 'stt-start': this.setStatus('Listening...', 'recording'); break;
            case 'stt-end':
                const text = event.data?.stt_output?.text || "(silence)";
                this.log(text, 'user');
                this.setStatus('Processing...', 'processing');
                break;
            case 'tts-start':
                const ttsText = event.data?.tts_output?.text || "";
                if (ttsText) this.log(ttsText, 'assistant');
                this.setStatus('Speaking...', 'speaking');
                break;
            case 'tts-end':
                if (event.data?.tts_output?.url) this.playAudio(event.data.tts_output.url);
                break;
            case 'run-end':
                this.playBeep(2); // Done beep
                this.haPipelineId = null; // Immediately stop sending audio
                if (this.haConnection.lastId) { // Use the request ID to clear the listener
                    this.haConnection.eventListeners.delete(this.haConnection.lastId);
                }
                setTimeout(() => {
                    if (this.currentState === 'assist_active' && !this.isPlayingTTS) {
                        this.returnToWakeWord();
                    }
                }, 1000);
                break;
            case 'error':
                this.log(`Error: ${event.data.message}`, 'error');
                this.returnToWakeWord();
                break;
        }
    }

    playAudio(url) {
        // url is relative to HA
        const fullUrl = this._hass.auth.data.hassUrl + url; // Simple concatenation? HA URLs usually don't end with slash?
        // Actually hassUrl might not be set in some cases, fallback to location.origin if relative
        
        this.isPlayingTTS = true;
        const audio = new Audio(fullUrl);
        audio.onended = () => {
            this.isPlayingTTS = false;
            this.returnToWakeWord();
        };
        audio.onerror = () => {
            this.isPlayingTTS = false;
            this.returnToWakeWord();
        };
        audio.play();
    }
    
    playBeep(type = 1) {
        const audio = new Audio(`/local/voice-satellite-card/assets/beep-${type}.wav`);
        audio.play().catch(e => console.error(e));
    }

    signalVisualFeedback(color) {
        const icon = this.shadowRoot.getElementById('status-icon');
        if (icon) {
            const originalColor = icon.style.borderColor; // Potrebbe essere vuoto
            icon.style.borderColor = color;
            // Revert the color after a short delay
            // Se il colore originale era vuoto, torna al default del CSS.
            setTimeout(() => { icon.style.borderColor = originalColor || ''; }, 500);
        }
    }

    setSpeakingIndicator(isActive) {
        const icon = this.shadowRoot.getElementById('status-icon');
        if (icon) {
            if (isActive) {
                // Set to yellow only if it's not already green from a recent wake word detection
                if (icon.style.borderColor !== 'green') {
                    icon.style.borderColor = 'yellow';
                }
            } else {
                icon.style.borderColor = ''; // Revert to default
            }
        }
    }
    returnToWakeWord() {
        this.setSpeakingIndicator(false); // Reset border color
        this.currentState = 'listening_ww';
        this.setStatus(`Listening for "${this.wakeWord}"`, 'listening');
        this.resetState();
    }

    floatTo16BitPCM(input) {
        const output = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return output;
    }
}

// --- Helper Class: HAConnection ---
class HAConnection {
    constructor(url, token) {
        // Convert http/https to ws/wss
        this.rawUrl = url;
        this.url = url.replace('http', 'ws') + '/api/websocket';
        this.token = token;
        this.socket = null;
        this.id = 1;
        this.pendingRequests = new Map();
        this.eventListeners = new Map();
        this.authenticated = false;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = new WebSocket(this.url);

            this.socket.onopen = () => {
                console.log('HA WS Connected');
            };

            this.socket.onmessage = (event) => {
                const message = JSON.parse(event.data);
                this.handleMessage(message, resolve, reject);
            };

            this.socket.onclose = () => {
                console.log('HA WS Closed');
                this.authenticated = false;
            };

            this.socket.onerror = (error) => {
                console.error('HA WS Error', error);
                reject(error);
            };
        });
    }

    handleMessage(message, resolveAuth, rejectAuth) {
        if (message.type === 'auth_required') {
            this.socket.send(JSON.stringify({
                type: 'auth',
                access_token: this.token
            }));
        } else if (message.type === 'auth_ok') {
            this.authenticated = true;
            resolveAuth();
        } else if (message.type === 'auth_invalid') {
            rejectAuth(new Error('Auth invalid'));
        } else if (message.type === 'result') {
            const resolveReq = this.pendingRequests.get(message.id);
            if (resolveReq) {
                // This is a response to a command we sent.
                if (!message.success) {
                    // The command failed. Reject the promise.
                    resolveReq.reject(message.error);
                    this.pendingRequests.delete(message.id);
                }
                // For assist_pipeline/run, we DO NOT resolve here. We wait for the 'run-start' event.
            }
        } else if (message.type === 'event') {
            const pendingReq = this.pendingRequests.get(message.id);

            // If this is the 'run-start' event for a pending request, resolve the promise.
            if (pendingReq && message.event.type === 'run-start') {
                // The handler ID for audio streaming is in runner_data.stt_binary_handler_id
                pendingReq.resolve({ handlerId: message.event.data?.runner_data?.stt_binary_handler_id, requestId: message.id });
                this.pendingRequests.delete(message.id);
                return; // Don't process this event further as a general event
            }

            // If there's a general event listener for this pipeline ID, call it.
            const eventCallback = this.eventListeners.get(message.id);
            if (eventCallback) eventCallback(message.event);
        }
    }

    runAssistPipeline(startStage = 'stt', endStage = 'tts', input = { sample_rate: 16000 }) {
        return new Promise((resolve, reject) => {
            const id = this.lastId = this.id++;
            this.pendingRequests.set(id, { resolve, reject }); // The key is the request ID

            const payload = {
                id,
                type: 'assist_pipeline/run',
                start_stage: startStage,
                end_stage: endStage,
                input: input
            };
            
            this.socket.send(JSON.stringify(payload));
        });
    }
    
    sendAudioChunk(handlerId, chunk) {
        if (!handlerId) return; // Don't send if handlerId is not set
        const audioBytes = new Uint8Array(chunk.buffer);
        const message = new Uint8Array(1 + audioBytes.length);
        message[0] = handlerId;
        message.set(audioBytes, 1);

        this.socket.send(message);
    }
}

customElements.define('voice-satellite-card', VoiceSatelliteCard);
