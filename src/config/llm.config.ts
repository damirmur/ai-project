import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { ILLMConfig, IAvailableModels } from '@types-def/llm.types.js';
import { getGpuConfig } from '@services/detect-gpu.service.js';

// Load environment variables
dotenv.config();

/**
 * Get available system memory in MB
 */
function getAvailableMemoryMB(): number {
  // Try to get from /proc/meminfo on Linux
  try {
    if (os.platform() === 'linux') {
      const meminfo = execSync('cat /proc/meminfo').toString();
      const memAvailableMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
      if (memAvailableMatch) {
        return Math.floor(parseInt(memAvailableMatch[1], 10) / 1024); // Convert KB to MB
      }
    }
  } catch (error) {
    // Fallback to total memory
  }
  
  // Fallback: use total memory from os module
  return Math.floor(os.totalmem() / (1024 * 1024));
}

/**
 * Get the base path for LLM models
 */
function getModelsBasePath(): string {
  const envPath = process.env.LLM_MODELS_PATH || '~/.local-llm-db/models';
  return envPath.replace('~', os.homedir());
}

/**
 * Get available models configuration
 */
export function getAvailableModels(): IAvailableModels {
  const modelsStr = process.env.AVAILABLE_MODELS || 'Qwen3.5-4B-Q5_K_S.gguf,gemma-4-E2B-it-UD-Q5_K_M.gguf';
  const models = modelsStr.split(',').map(m => m.trim());
  
  return {
    models,
    defaultModel: process.env.DEFAULT_MODEL || 'gemma-4-E2B-it-UD-Q5_K_M.gguf',
    modelsPath: getModelsBasePath()
  };
}

/**
 * Get LLM configuration from environment or command line
 * @param modelName Optional model name from command line
 */
export function getConfig(modelName?: string): ILLMConfig {
  const availableModels = getAvailableModels();
  const selectedModel = modelName || availableModels.defaultModel;
  const modelPath = path.join(availableModels.modelsPath, selectedModel);
  const logFile = process.env.LOG_FILE || 'testllm.log';

  // Read context size from environment variables
  const envContextMin = process.env.CONTEXT_SIZE_MIN ? parseInt(process.env.CONTEXT_SIZE_MIN, 10) : null;
  const envContextMax = process.env.CONTEXT_SIZE_MAX ? parseInt(process.env.CONTEXT_SIZE_MAX, 10) : null;

  let contextSizeMin: number;
  let contextSizeMax: number;

  if (envContextMin !== null && envContextMax !== null) {
    // Use values from .env (assumes GPU is available for efficient context handling)
    contextSizeMin = envContextMin;
    contextSizeMax = envContextMax;
    console.log(`📊 Using context size from .env: { min: ${contextSizeMin}, max: ${contextSizeMax} }`);
  } else {
    // Fallback: calculate based on available system memory (for CPU-only systems)
    const availableMemoryMB = getAvailableMemoryMB();
    const memoryForContextMB = Math.max(availableMemoryMB - 1024, 256); // Reserve 1GB for system
    const maxContextSize = Math.floor((memoryForContextMB * 1024) / 2); // 2KB per token estimate

    contextSizeMin = 512;
    contextSizeMax = Math.min(Math.max(maxContextSize, 4096), 131072);
    
    console.log(`📊 No .env context size - calculating based on available memory`);
    console.log(`📊 Available memory: ${availableMemoryMB}MB, Memory for context: ${memoryForContextMB}MB`);
    console.log(`📊 Context size: { min: ${contextSizeMin}, max: ${contextSizeMax} }`);
  }

  // Detect GPU configuration
  const gpuConfig = getGpuConfig();

  // Read system prompt from environment
  const systemPrompt = process.env.SYSTEM_PROMPT || 'You are a useful assistant, answer in Russian.';

  return {
    modelPath,
    modelName: selectedModel,
    logFilePath: logFile,
    contextSize: { min: contextSizeMin, max: contextSizeMax },
    gpuLayers: gpuConfig.gpuLayers,
    enableLogging: true,
    systemPrompt
  };
}
