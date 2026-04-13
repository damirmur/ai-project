import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { ILLMConfig, IAvailableModels } from '@types-def/llm.types.js';

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

  // Calculate context size based on available memory
  const availableMemoryMB = getAvailableMemoryMB();
  // Reserve 1GB for system, use rest for context
  const memoryForContextMB = Math.max(availableMemoryMB - 1024, 256); // At least 256MB
  
  // Estimate tokens: roughly 2KB per token in context (conservative estimate)
  // This accounts for model weights + context
  const maxContextSize = Math.floor((memoryForContextMB * 1024) / 2); // 2KB per token estimate
  
  // Set reasonable limits
  const contextSizeMin = 512;
  const contextSizeMax = Math.min(Math.max(maxContextSize, 4096), 131072); // Between 4K and 128K

  console.log(`📊 Available memory: ${availableMemoryMB}MB`);
  console.log(`📊 Memory for context: ${memoryForContextMB}MB`);
  console.log(`📊 Context size: { min: ${contextSizeMin}, max: ${contextSizeMax} }`);

  return {
    modelPath,
    modelName: selectedModel,
    logFilePath: logFile,
    contextSize: { min: contextSizeMin, max: contextSizeMax },
    gpuLayers: undefined, // Use default
    enableLogging: true
  };
}
