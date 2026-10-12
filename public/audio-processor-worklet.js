/**
 * Audio Processor Worklet for Gemini Live API
 * Captures microphone audio and converts to PCM16 format
 * This replaces deprecated ScriptProcessorNode
 */

class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];

        if (input && input.length > 0) {
            const inputData = input[0]; // First channel (mono)

            if (inputData && inputData.length > 0) {
                // Convert Float32 to Int16 PCM
                const pcm16 = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                // Send PCM data to main thread
                this.port.postMessage({
                    type: 'audio-data',
                    data: pcm16.buffer
                }, [pcm16.buffer]); // Transfer ownership for performance
            }
        }

        return true; // Keep processor alive
    }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
