import {
  Llama,
  LlamaModel,
  LlamaContext,
  LlamaChatSession,
  getLlama
} from 'node-llama-cpp';
import type { IModelInfo, ContextSize } from '@types-def/llm.types.js';
import type { ILLMService } from '@types-def/services.types.js';
import { getGpuConfig } from './detect-gpu.service.js';
import os from 'os';
import fs from 'fs';

export class LLMService implements ILLMService {
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private context: LlamaContext | null = null;
  private session: LlamaChatSession | null = null;
  private modelInfo: IModelInfo | null = null;
  private contextSize: ContextSize = { min: 512, max: 8192 };
  private actualContextSize: number = 8192; // Default to max for better performance
  private detectedGpuLayers: number = 0;

  /**
   * Load a model from the specified path
   */
  async loadModel(modelPath: string, contextSize?: ContextSize, gpuLayersOverride?: number | 'auto', systemPrompt?: string): Promise<void> {
    if (contextSize) {
      this.contextSize = contextSize;
      // Use the max value from the range for actual context size
      if (typeof contextSize === 'object' && 'min' in contextSize && 'max' in contextSize) {
        this.actualContextSize = contextSize.max;
      } else if (typeof contextSize === 'number') {
        this.actualContextSize = contextSize;
      }
    }

    // Detect GPU configuration
    let modelSizeMB = 0;
    try {
      const stats = fs.statSync(modelPath);
      modelSizeMB = Math.floor(stats.size / (1024 * 1024));
    } catch (error) {
      // Ignore if can't get model size
    }

    const gpuConfig = getGpuConfig(modelSizeMB);
    const gpuLayers = gpuLayersOverride ?? gpuConfig.gpuLayers;
    this.detectedGpuLayers = typeof gpuLayers === 'number' ? gpuLayers : 0;

    // Reuse existing Llama instance or create a new one
    if (!this.llama) {
      console.log(`🔧 GPU configuration: ${gpuConfig.gpu ? gpuConfig.gpu : 'CPU'}, Layers: ${gpuLayers}`);
      
      this.llama = await getLlama({
        gpu: gpuConfig.gpu
      });
      
      if (gpuConfig.gpu) {
        console.log(`✅ Llama initialized with ${gpuConfig.gpu.toUpperCase()} GPU`);
      } else {
        console.log('⚠️  Llama initialized in CPU mode');
      }
    }

    console.log(`Loading model: ${modelPath} (${modelSizeMB}MB)`);

    this.model = await this.llama.loadModel({
      modelPath,
      gpuLayers: gpuLayers
    });

    this.context = await this.model.createContext(
      {
        contextSize: 'auto', // Let node-llama-cpp determine optimal context size
        flashAttention: true,
        threads: Math.min(8, os.cpus().length), // 4-8 threads optimal for GPU
        batchSize: 512 // Default batchSize for efficient GPU processing
      }
    );
    // Update actualContextSize with the real value
    this.actualContextSize = this.context.contextSize;
    this.session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      systemPrompt: systemPrompt || 'You are a useful assistant, answer in Russian.'
    });

    this.modelInfo = {
      name: modelPath.split('/').pop() || modelPath,
      filePath: modelPath
    };

    console.log('Model loaded successfully');
  }

  /**
   * Get the current context size configuration
   */
  getContextSize(): ContextSize {
    return this.contextSize;
  }

  /**
   * Get the actual context size from the loaded LlamaContext
   */
  getActualContextSize(): number | null {
    return this.context?.contextSize ?? null;
  }

  /**
   * Get the number of layers offloaded to GPU
   */
  getGpuLayers(): number {
    // Return detected GPU layers instead of model's gpuLayers
    return this.detectedGpuLayers;
  }

  /**
   * Generate a response from the model
   */
  async generateResponse(prompt: string): Promise<string> {
    if (!this.session) {
      throw new Error('Model not loaded. Call loadModel() first.');
    }

    console.log('Generating response...');
    console.log(`User prompt: ${prompt}`);

    const response = await this.session.prompt(prompt, {
      temperature: 0.7,
      repeatPenalty: { penalty: 1.15, lastTokens: 64 },
      customStopTriggers: ['</s>', '<|end_of_text|>', '<|eot_id|>', 'User:', 'AI:']
    });

    // Debug info
    console.log(`Response length: ${response.length}`);
    console.log(`Response type: ${typeof response}`);
    console.log(`Response (raw): [${response}]`);

    if (!response || response.trim().length === 0) {
      console.warn('WARNING: Model returned empty response!');
    } else {
      console.log('Response generated successfully');
    }

    return response;
  }

  /**
   * Generate a streaming response from the model
   */
  async generateStreamingResponse(
    prompt: string,
    onToken: (token: string) => void
  ): Promise<string> {
    if (!this.session) {
      throw new Error('Model not loaded. Call loadModel() first.');
    }

    console.log('Generating streaming response...');
    console.log(`User prompt: ${prompt}`);

    let fullResponse = '';

    const response = await this.session.prompt(prompt, {
      temperature: 0.7,
      repeatPenalty: { penalty: 1.15, lastTokens: 64 },
      customStopTriggers: ['</s>', '<|end_of_text|>', '<|eot_id|>', 'User:', 'AI:'],
      onTextChunk: (chunk: string) => {
        fullResponse += chunk;
        onToken(chunk);
      }
    });

    // If the streaming didn't work, fallback to the response
    const finalResponse = response || fullResponse;

    // Debug info
    console.log(`\nResponse length: ${finalResponse.length}`);
    console.log(`Response type: ${typeof finalResponse}`);

    if (!finalResponse || finalResponse.trim().length === 0) {
      console.warn('WARNING: Model returned empty response!');
    } else {
      console.log('Response generated successfully');
    }

    return finalResponse;
  }

  /**
   * Get model information
   */
  getModelInfo(): IModelInfo | null {
    return this.modelInfo;
  }

  /**
   * Clear model memory and unload
   */
  async clearMemory(): Promise<void> {
    console.log('Clearing memory and unloading model...');

    if (this.session) {
      this.session.dispose();
      this.session = null;
    }

    if (this.context) {
      this.context.dispose();
      this.context = null;
    }

    if (this.model) {
      this.model.dispose();
      this.model = null;
    }

    if (this.llama) {
      this.llama.dispose();
      this.llama = null;
    }

    this.modelInfo = null;
    console.log('Memory cleared');
  }
}
