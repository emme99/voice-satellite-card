/**
 * Voice Satellite Card
 * Version: v0.3.0
 */
console.info(
    `%c VOICE-SATELLITE-CARD %c v0.3.0 `,
    'color: white; background: #03a9f4; font-weight: 700;',
    'color: #03a9f4; background: white; font-weight: 700;',
);
const BASE_URL = new URL('.', import.meta.url).href;

class HAConnection {
    constructor(url, token) {
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
            this.socket.onopen = () => console.log('HA WS Connected');
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
            this.socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        } else if (message.type === 'auth_ok') {
            this.authenticated = true;
            resolveAuth();
        } else if (message.type === 'auth_invalid') {
            rejectAuth(new Error('Auth invalid'));
        } else if (message.type === 'result') {
            const resolveReq = this.pendingRequests.get(message.id);
            if (resolveReq && !message.success) {
                resolveReq.reject(message.error);
                this.pendingRequests.delete(message.id);
            }
        } else if (message.type === 'event') {
            const pendingReq = this.pendingRequests.get(message.id);
            if (pendingReq && message.event.type === 'run-start') {
                pendingReq.resolve({ handlerId: message.event.data?.runner_data?.stt_binary_handler_id, requestId: message.id });
                this.pendingRequests.delete(message.id);
                return;
            }
            const eventCallback = this.eventListeners.get(message.id);
            if (eventCallback) eventCallback(message.event);
        }
    }

    runAssistPipeline(startStage = 'stt', endStage = 'tts', input = { sample_rate: 16000 }) {
        return new Promise((resolve, reject) => {
            const id = this.id++;
            this.pendingRequests.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, type: 'assist_pipeline/run', start_stage: startStage, end_stage: endStage, input }));
        });
    }

    sendAudioChunk(handlerId, chunk) {
        if (!handlerId) return;
        const audioBytes = new Uint8Array(chunk.buffer);
        const message = new Uint8Array(1 + audioBytes.length);
        message[0] = handlerId;
        message.set(audioBytes, 1);
        this.socket.send(message);
    }
}

class VoiceSatelliteCard extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._initialized = false;
        this._hass = null;
        this._config = {};
        this.isListening = false;
        this.currentState = 'idle';
        this.models = {};
        this.wakeWord = 'ok_nabu';
        this.pipelineId = undefined;
        this.mode = 'voice';
        this._cardStyle = 'card';
        this.audioContext = null;
        this.workletNode = null;
        this.mediaStream = null;
        this.mel_buffer = [];
        this.embedding_buffer = [];
        this.vadState = { h: null, c: null };
        this.isSpeechActive = false;
        this.vadHangoverCounter = 0;
        this.isDetectionCoolingDown = false;
        this.haConnection = null;
        this.haPipelineId = null;
        this.isPlayingTTS = false;
        this.SAMPLE_RATE = 16000;
        this.FRAME_SIZE = 1280;
        this.VAD_HANGOVER_FRAMES = 12;
    }

    setConfig(config) {
        const oldStyle = this._cardStyle;
        const oldMode = this.mode;
        
        this._config = config;
        this.wakeWord = config.wake_word || 'ok_nabu';
        this.pipelineId = config.pipeline;
        
        if (config.mode) this.mode = config.mode;
        else if (config.extended_mode === true) this.mode = 'both';
        else this.mode = 'voice';
        
        this._cardStyle = config.style || 'card';

        // Re-render if something changed and we are already initialized
        if (this._initialized && (oldStyle !== this._cardStyle || oldMode !== this.mode)) {
            this.render();
            // If we changed to a mode that needs models, load them
            if (this.mode !== 'text') this.loadModels();
        }
    }

    set hass(hass) {
        const oldHass = this._hass;
        this._hass = hass;
        
        if (!this._initialized && hass) {
            this.init();
        } else if (this.haConnection && oldHass && oldHass.auth.data.access_token !== hass.auth.data.access_token) {
            // Update token if it changed
            this.haConnection.token = hass.auth.data.access_token;
        }
    }

    async init() {
        try {
            this._initialized = true;
            this.render();
            if (!window.ort) await this.loadScript(new URL('ort.wasm.min.js', BASE_URL).href);
            ort.env.wasm.wasmPaths = BASE_URL;
            this.initHAConnection();
            if (this.mode !== 'text') this.loadModels();
        } catch (e) {
            console.error("Init failed:", e);
            this.setStatus('Init Failed', 'error');
        }
    }

    disconnectedCallback() {
        this.log('Card removed from DOM', 'system');
        if (this.haConnection && this.haConnection.socket) {
            this.haConnection.socket.close();
            this.haConnection = null;
        }
        if (this.isListening) {
            this.stopListening();
        }
    }

    loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src; script.onload = resolve; script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    initHAConnection() {
        if (this.haConnection) return;
        const auth = this._hass.auth;
        const url = auth.data.hassUrl || window.location.origin;
        this.haConnection = new HAConnection(url, auth.data.access_token);
        this.haConnection.connect().catch(e => {
            console.error("HA Connection Error:", e);
            this.log(`Connection error: ${e.message}`, 'error');
        });
    }

    async loadModels() {
        const btn = this.shadowRoot.getElementById('start-button');
        if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }
        try {
            const basePath = new URL('models/', BASE_URL).href;
            let modelFile = this.wakeWord === 'alexa' ? 'alexa_v0.1.onnx' : 
                        this.wakeWord === 'hey_jarvis' ? 'hey_jarvis_v0.1.onnx' :
                        this.wakeWord === 'hey_rhasspy' ? 'hey_rhasspy_v0.1.onnx' :
                        this.wakeWord === 'nexoos' ? 'nexoos.onnx' : 'ok_nabu.onnx';
            this.models = { [this.wakeWord]: { url: basePath + modelFile, session: null, scores: new Array(50).fill(0) } };
            const sessionOptions = { executionProviders: ['wasm'] };
            [this.melspecModel, this.embeddingModel, this.vadModel] = await Promise.all([
                ort.InferenceSession.create(basePath + 'melspectrogram.onnx', sessionOptions),
                ort.InferenceSession.create(basePath + 'embedding_model.onnx', sessionOptions),
                ort.InferenceSession.create(basePath + 'silero_vad.onnx', sessionOptions)
            ]);
            for (const name in this.models) this.models[name].session = await ort.InferenceSession.create(this.models[name].url, sessionOptions);
            if (btn) { btn.disabled = false; btn.textContent = 'Start Listening'; }
        } catch(e) { console.error(e); }
    }

    render() {
        const isFab = this._cardStyle === 'fab';
        const isText = this.mode === 'text';
        const isBoth = this.mode === 'both';

        let content = '';
        if (isFab) {
            content = `<div id="fab-button" class="fab-container"><img id="status-icon" src="${new URL('assets/idle.jpg', BASE_URL).href}"></div>`;
        } else {
            content = `
                <div class="card">
                    <h2>Voice Satellite</h2>
                    ${!isText ? `
                        <img id="status-icon" class="status-icon" src="${new URL('assets/idle.jpg', BASE_URL).href}">
                        <div id="status-text" class="status-text">Ready</div>
                        <button id="start-button">Start Listening</button>
                        <button id="stop-button" style="display:none">Stop</button>
                    ` : ''}
                    ${isText || isBoth ? `
                        <div id="chat-container" class="chat-container"></div>
                        <div class="input-area">
                            <input type="text" id="chat-input" placeholder="Type a message...">
                            <button id="send-button" style="width: auto; margin-top: 0;">Send</button>
                        </div>
                    ` : ''}
                    <div style="margin-top: 10px;"><label><input type="checkbox" id="debug-toggle"> Debug Log</label></div>
                    <div id="debug-log" class="debug-log"></div>
                </div>`;
        }

        this.shadowRoot.innerHTML = `
            <style>
                :host { display: block; }
                .card { background: var(--ha-card-background, var(--card-background-color, white)); border-radius: var(--ha-card-border-radius, 4px); box-shadow: var(--ha-card-box-shadow, 0 2px 1px -1px rgba(0,0,0,0.2)); padding: 16px; text-align: center; color: var(--primary-text-color); }
                .status-icon { width: 100px; height: 100px; border-radius: 50%; object-fit: cover; border: 4px solid var(--divider-color, #e0e0e0); transition: border-color 0.2s; margin: 16px auto; display: block; }
                .status-text { font-size: 1.2rem; margin-bottom: 16px; font-style: italic; min-height: 1.5em; }
                button { background: var(--primary-color); color: var(--text-primary-color); border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; width: 100%; margin-top: 8px; }
                button:disabled { background: var(--disabled-text-color); cursor: not-allowed; }
                .debug-log { margin-top: 16px; text-align: left; background: var(--secondary-background-color); padding: 8px; border-radius: 4px; font-family: monospace; font-size: 0.8rem; max-height: 150px; overflow-y: auto; display: none; }
                .log-entry { margin-bottom: 4px; border-bottom: 1px solid var(--divider-color); }
                .chat-container { display: flex; flex-direction: column; height: 300px; overflow-y: auto; border: 1px solid var(--divider-color); border-radius: 4px; padding: 8px; margin-top: 16px; background: var(--secondary-background-color); }
                .chat-bubble { padding: 8px 12px; border-radius: 12px; margin-bottom: 8px; max-width: 80%; word-wrap: break-word; }
                .chat-bubble.user { align-self: flex-end; background: var(--primary-color); color: var(--text-primary-color); border-bottom-right-radius: 2px; }
                .chat-bubble.assistant { align-self: flex-start; background: var(--card-background-color); color: var(--primary-text-color); border: 1px solid var(--divider-color); border-bottom-left-radius: 2px; }
                .input-area { display: flex; margin-top: 8px; gap: 8px; }
                .input-area input { flex-grow: 1; padding: 8px; border: 1px solid var(--divider-color); border-radius: 4px; }
                .fab-container { position: fixed; right: 16px; bottom: 16px; z-index: 1000; width: 70px; height: 70px; background: var(--ha-card-background, var(--card-background-color, white)); border-radius: 50%; box-shadow: 0 3px 5px -1px rgba(0,0,0,0.2); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: transform 0.2s; border: 3px solid var(--divider-color, #e0e0e0); overflow: hidden; }
                .fab-container:active { transform: scale(0.9); }
                .fab-container img { width: 100%; height: 100%; object-fit: cover; }
            </style>
            ${content}`;

        if (isFab) {
            const fab = this.shadowRoot.getElementById('fab-button');
            if (fab) fab.addEventListener('click', () => this.isListening ? this.stopListening() : this.startListening());
        } else {
            if (!isText) {
                const startBtn = this.shadowRoot.getElementById('start-button');
                const stopBtn = this.shadowRoot.getElementById('stop-button');
                if (startBtn) startBtn.addEventListener('click', () => this.startListening());
                if (stopBtn) stopBtn.addEventListener('click', () => this.stopListening());
            }
            const debugToggle = this.shadowRoot.getElementById('debug-toggle');
            const debugLog = this.shadowRoot.getElementById('debug-log');
            if (debugToggle) debugToggle.addEventListener('change', (e) => {
                debugLog.style.display = e.target.checked ? 'block' : 'none';
                if (!e.target.checked) debugLog.innerHTML = '';
            });
            if (isText || isBoth) {
                const chatInput = this.shadowRoot.getElementById('chat-input');
                const sendButton = this.shadowRoot.getElementById('send-button');
                if (sendButton) sendButton.addEventListener('click', () => this.sendText());
                if (chatInput) chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.sendText(); });
            }
        }
    }

    log(message, type = 'system') {
        const debugToggle = this.shadowRoot.getElementById('debug-toggle');
        if (debugToggle && debugToggle.checked) {
            const debugLog = this.shadowRoot.getElementById('debug-log');
            const div = document.createElement('div');
            div.className = `log-entry ${type}`;
            div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
            debugLog.appendChild(div);
            debugLog.scrollTop = debugLog.scrollHeight;
        }
    }

    setStatus(status, state) {
        if (this.mode === 'text' && this._cardStyle !== 'fab') return;
        const statusText = this.shadowRoot.getElementById('status-text');
        if (statusText) statusText.textContent = status;
        let iconName = state === 'listening' ? 'listening.jpg' : state === 'speaking' ? 'speaking.jpg' : state === 'processing' ? 'processing.jpg' : state === 'recording' ? 'recording.jpg' : state === 'error' ? 'error.jpg' : 'idle.jpg';
        const icon = this.shadowRoot.getElementById('status-icon');
        if (icon) icon.src = new URL(`assets/${iconName}`, BASE_URL).href;
    }


    resetState() {
        this.mel_buffer = [];
        this.embedding_buffer = Array.from({length: 16}, () => new Float32Array(96).fill(0));
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
        for (const name in this.models) this.models[name].scores.fill(0);
    }

    async startListening() {
        if (this.isListening) return;
        this.resetState();
        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
            this.audioContext = new AudioContext({ sampleRate: this.SAMPLE_RATE });
            const source = this.audioContext.createMediaStreamSource(this.mediaStream);
            const audioProcessorCode = `class AudioProcessor extends AudioWorkletProcessor { bufferSize = 1280; _buffer = new Float32Array(this.bufferSize); _pos = 0; process(inputs) { const input = inputs[0][0]; if (input) { for (let i = 0; i < input.length; i++) { this._buffer[this._pos++] = input[i]; if (this._pos === this.bufferSize) { this.port.postMessage(this._buffer); this._pos = 0; } } } return true; } } registerProcessor('audio-processor', AudioProcessor);`;
            const blob = new Blob([audioProcessorCode], { type: 'application/javascript' });
            const workletURL = URL.createObjectURL(blob);
            await this.audioContext.audioWorklet.addModule(workletURL);
            this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor');
            this.workletNode.port.onmessage = async (event) => {
                const chunk = event.data;
                if (!chunk) return;
                if (this.currentState === 'listening_ww') {
                    const vadFired = await this.runVad(chunk);
                    const wasSpeechActive = this.isSpeechActive;
                    if (vadFired) { this.isSpeechActive = true; this.vadHangoverCounter = this.VAD_HANGOVER_FRAMES; if (!wasSpeechActive) this.setSpeakingIndicator(true); }
                    else if (this.vadHangoverCounter > 0) this.vadHangoverCounter--;
                    this.isSpeechActive = this.vadHangoverCounter > 0;
                    await this.runInference(chunk);
                    if (wasSpeechActive && !this.isSpeechActive) this.setSpeakingIndicator(false);
                } else if (this.currentState === 'assist_active' && this.haConnection && this.haPipelineId) {
                    this.haConnection.sendAudioChunk(this.haPipelineId, this.floatTo16BitPCM(chunk));
                }
            };
            source.connect(this.workletNode);
            this.workletNode.connect(this.audioContext.destination);
            this.isListening = true;
            this.toggleButtons(true);
            this.currentState = 'listening_ww';
            this.setStatus(`Listening for "${this.wakeWord}"`, 'listening');
        } catch (err) { console.error(err); this.stopListening(); }
    }

    toggleButtons(isListening) {
        const startBtn = this.shadowRoot.getElementById('start-button');
        const stopBtn = this.shadowRoot.getElementById('stop-button');
        if (startBtn) startBtn.style.display = isListening ? 'none' : 'block';
        if (stopBtn) stopBtn.style.display = isListening ? 'block' : 'none';
        if (startBtn) { startBtn.textContent = 'Start Listening'; startBtn.disabled = false; }
    }

    stopListening() {
        if (this.isListening) {
            if (this.mediaStream) this.mediaStream.getTracks().forEach(track => track.stop());
            if (this.workletNode) { this.workletNode.port.onmessage = null; this.workletNode.disconnect(); this.workletNode = null; }
            if (this.audioContext && this.audioContext.state !== 'closed') this.audioContext.close();
            this.isListening = false;
        }
        this.toggleButtons(false);
        this.currentState = 'idle';
        this.setStatus('Stopped', 'idle');
    }

    async runVad(chunk) {
        try {
            const tensor = new ort.Tensor('float32', chunk, [1, chunk.length]);
            const sr = new ort.Tensor('int64', [BigInt(this.SAMPLE_RATE)], []);
            const res = await this.vadModel.run({ input: tensor, sr: sr, h: this.vadState.h, c: this.vadState.c });
            this.vadState.h = res.hn; this.vadState.c = res.cn;
            return res.output.data[0] > 0.5;
        } catch (err) { return false; }
    }

    async runInference(chunk) {
        const melspecTensor = new ort.Tensor('float32', chunk, [1, this.FRAME_SIZE]);
        const melspecResults = await this.melspecModel.run({ [this.melspecModel.inputNames[0]]: melspecTensor });
        let new_mel_data = melspecResults[this.melspecModel.outputNames[0]].data;
        for (let j = 0; j < new_mel_data.length; j++) new_mel_data[j] = (new_mel_data[j] / 10.0) + 2.0;
        for (let j = 0; j < 5; j++) this.mel_buffer.push(new Float32Array(new_mel_data.subarray(j * 32, (j + 1) * 32)));
        while (this.mel_buffer.length >= 76) {
            const flattened_mel = new Float32Array(76 * 32);
            for (let j = 0; j < 76; j++) flattened_mel.set(this.mel_buffer[j], j * 32);
            const embeddingOut = await this.embeddingModel.run({ [this.embeddingModel.inputNames[0]]: new ort.Tensor('float32', flattened_mel, [1, 76, 32, 1]) });
            this.embedding_buffer.shift();
            this.embedding_buffer.push(new Float32Array(embeddingOut[this.embeddingModel.outputNames[0]].data));
            const flattened_embeddings = new Float32Array(16 * 96);
            for (let j = 0; j < 16; j++) flattened_embeddings.set(this.embedding_buffer[j], j * 96);
            const final_input_tensor = new ort.Tensor('float32', flattened_embeddings, [1, 16, 96]);
            for (const name in this.models) {
                const results = await this.models[name].session.run({ [this.models[name].session.inputNames[0]]: final_input_tensor });
                const score = results[this.models[name].session.outputNames[0]].data[0];
                if (score > 0.5 && this.isSpeechActive && !this.isDetectionCoolingDown) {
                    this.isDetectionCoolingDown = true;
                    this.signalVisualFeedback('green');
                    this.switchToAssist();
                    setTimeout(() => this.isDetectionCoolingDown = false, 2000);
                } else if (score > 0.3 && this.isSpeechActive && !this.isDetectionCoolingDown) {
                    this.signalVisualFeedback('orange');
                }
            }
            this.mel_buffer.splice(0, 8);
        }
    }

    async switchToAssist() {
        this.currentState = 'assist_active';
        this.playBeep();
        this.setStatus('Speaking to Home Assistant', 'recording');
        const { handlerId, requestId } = await this.haConnection.runAssistPipeline('stt', 'tts', { sample_rate: this.SAMPLE_RATE, pipeline_id: this.pipelineId });
        this.haPipelineId = handlerId;
        if (handlerId) this.haConnection.eventListeners.set(requestId, (event) => this.handlePipelineEvent(event));
    }

    handlePipelineEvent(event) {
        switch (event.type) {
            case 'stt-start': this.setStatus('Listening...', 'recording'); break;
            case 'stt-end':
                const text = event.data?.stt_output?.text || "(silence)";
                this.log(text, 'user');
                if (this.mode === 'text' || this.mode === 'both') this.appendChatMessage(text, 'user');
                this.setStatus('Processing...', 'processing');
                break;
            case 'tts-start':
                const ttsText = event.data?.tts_input || event.data?.tts_output?.text || "";
                if (ttsText) {
                    this.log(ttsText, 'assistant');
                    if (this.mode === 'text' || this.mode === 'both') this.appendChatMessage(ttsText, 'assistant');
                }
                this.setStatus('Speaking...', 'speaking');
                break;
            case 'tts-end': if (event.data?.tts_output?.url) this.playAudio(event.data.tts_output.url); break;
            case 'run-end':
                this.playBeep(2); this.haPipelineId = null;
                setTimeout(() => { if (this.currentState === 'assist_active' && !this.isPlayingTTS) this.returnToWakeWord(); }, 1000);
                break;
            case 'error': this.log(`Error: ${event.data.message}`, 'error'); this.returnToWakeWord(); break;
        }
    }

    playAudio(url) {
        this.isPlayingTTS = true;
        const audio = new Audio(this._hass.auth.data.hassUrl + url);
        audio.onended = () => { this.isPlayingTTS = false; this.returnToWakeWord(); };
        audio.onerror = () => { this.isPlayingTTS = false; this.returnToWakeWord(); };
        audio.play();
    }
    
    playBeep(type = 1) {
        new Audio(new URL(`assets/beep-${type}.wav`, BASE_URL).href).play().catch(() => {});
    }

    signalVisualFeedback(color) {
        const icon = this.shadowRoot.getElementById('status-icon');
        if (icon) {
            const old = icon.style.borderColor;
            icon.style.borderColor = color;
            setTimeout(() => icon.style.borderColor = old || '', 500);
        }
    }

    setSpeakingIndicator(isActive) {
        const icon = this.shadowRoot.getElementById('status-icon');
        if (icon) icon.style.borderColor = isActive ? 'yellow' : '';
    }

    returnToWakeWord() {
        this.setSpeakingIndicator(false);
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

    async sendText() {
        const input = this.shadowRoot.getElementById('chat-input');
        const text = input ? input.value.trim() : '';
        if (!text) return;
        input.value = '';
        this.appendChatMessage(text, 'user');
        try {
            const { requestId } = await this.haConnection.runAssistPipeline('intent', 'tts', { text, pipeline_id: this.pipelineId });
            this.haConnection.eventListeners.set(requestId, (event) => this.handlePipelineEvent(event));
        } catch (e) { console.error(e); }
    }

    appendChatMessage(text, sender) {
        const container = this.shadowRoot.getElementById('chat-container');
        if (!container) return;
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${sender}`; bubble.textContent = text;
        container.appendChild(bubble); container.scrollTop = container.scrollHeight;
    }
}

customElements.define('voice-satellite-card', VoiceSatelliteCard);
