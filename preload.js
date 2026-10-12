const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Try to load @huggingface/inference — fall back to direct fetch if it fails
let InferenceClient;
try {
  InferenceClient = require('@huggingface/inference').InferenceClient;
} catch (e) {
  console.warn('[HF] @huggingface/inference require failed:', e.message, '— using direct fetch fallback');
}

async function hfTextToImageFallback(apiKey, prompt) {
  const response = await fetch(
    'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ inputs: prompt }),
    }
  );
  if (!response.ok) {
    if (response.status === 503) throw new Error('Model is warming up (Free Tier). Please try again in 20 seconds.');
    const text = await response.text();
    throw new Error(`HF API returned status ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.headers.get('content-type')?.includes('image')) {
    const text = await response.text();
    throw new Error(`Unexpected response: ${text.slice(0, 500)}`);
  }
  return await response.blob();
}

async function handleHfGenerateImage({ prompt }) {
  try {
    const apiKey = await ipcRenderer.invoke('read-hf-key');
    if (!apiKey) {
      return { success: false, error: 'Hugging Face API key not configured. Please add it in Settings.' };
    }
    let imageBlob;
    if (InferenceClient) {
      const client = new InferenceClient(apiKey);
      imageBlob = await client.textToImage({
        model: 'black-forest-labs/FLUX.1-schnell',
        inputs: prompt
      });
    } else {
      imageBlob = await hfTextToImageFallback(apiKey, prompt);
    }
    const arrayBuffer = await imageBlob.arrayBuffer();
    const buffer = Array.from(new Uint8Array(arrayBuffer));
    const result = await ipcRenderer.invoke('save-image-file', { buffer, prompt });
    return result;
  } catch (e) {
    let msg = e.message || String(e);
    if (msg.includes('503') || msg.includes('loading')) {
      msg = 'Model is warming up (Free Tier). Please try again in 20 seconds.';
    }
    return { success: false, error: msg };
  }
}

const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);

contextBridge.exposeInMainWorld('electronAPI', {
    onUpdateLog: (callback) => ipcRenderer.on('update-log', (_event, value) => callback(value)),
    setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
    getZoomFactor: () => webFrame.getZoomFactor(),
    notifyAppReady: () => ipcRenderer.invoke('splash-transition-complete'),
    invoke: (channel, ...args) => {
        if (channel === 'hf-generate-image') {
          return handleHfGenerateImage(args[0] || {});
        }
        // License/Payment system bypass - always return success
        if (channel === 'auth-check-access') {
            return Promise.resolve({ success: true, approved: true, access: true, message: 'Access granted' });
        }
        if (channel === 'auth-get-stored') {
            return Promise.resolve({ email: 'user@example.com', authenticated: true });
        }
        if (channel === 'auth-save') {
            return Promise.resolve(true);
        }
        if (channel === 'auth-delete') {
            return Promise.resolve(true);
        }
        if (channel === 'auth-logout-device') {
            return Promise.resolve({ success: true });
        }
        if (channel === 'auth-start-callback-server') {
            return Promise.resolve({ success: true, port: 53921 });
        }
        if (channel === 'auth-stop-callback-server') {
            return Promise.resolve(true);
        }
        if (channel === 'get-codex-auth-status') {
            return Promise.resolve({ authenticated: true });
        }
        if (channel === 'start-codex-login') {
            return Promise.resolve({ success: true, code: 'XXXX-XXXX', url: 'https://auth.openai.com/codex/device' });
        }
        if (channel === 'cancel-codex-login') {
            return Promise.resolve(true);
        }
        if (channel === 'get-gemini-token') {
            return originalInvoke(channel, ...args);
        }
        if (channel === 'launch-browser-login-session') {
            return Promise.resolve({ success: true });
        }
        return originalInvoke(channel, ...args);
    },
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    on: (channel, callback) => {
        const subscription = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, subscription);
        return () => ipcRenderer.removeListener(channel, subscription);
    },
    onUpdateStatus: (callback) => {
        const subscription = (_event, data) => callback(data);
        ipcRenderer.on('update-status', subscription);
        return () => ipcRenderer.removeListener('update-status', subscription);
    },
    installUpdate: () => ipcRenderer.invoke('install-update'),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
});

// Pre-fetch dynamic system paths so they are immediately available to the renderer
ipcRenderer.invoke('get-system-paths').then((paths) => {
  if (paths) {
    try {
      webFrame.executeJavaScript(`window.__akkiSystemPaths = ${JSON.stringify(paths)};`);
    } catch {}
  }
}).catch(() => {});
