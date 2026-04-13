/**
 * Context size configuration
 */
export type ContextSize = 'auto' | number | { min: number; max: number };

/**
 * Configuration interface for the LLM testing application
 */
export interface ILLMConfig {
  /** Path to the model file */
  modelPath: string;
  /** Name of the model */
  modelName: string;
  /** Path to log file */
  logFilePath: string;
  /** Maximum context window size */
  contextSize?: ContextSize;
  /** Number of layers to offload to GPU (-1 for all) */
  gpuLayers?: number;
  /** Enable logging */
  enableLogging: boolean;
}

/**
 * Interface for model information
 */
export interface IModelInfo {
  /** Model name */
  name: string;
  /** Model file path */
  filePath: string;
  /** Model size in bytes */
  size?: number;
}

/**
 * Interface for test results
 */
export interface ITestResult {
  /** Model name used */
  modelName: string;
  /** Question asked */
  question: string;
  /** Response from model */
  response: string;
  /** Time taken for response in milliseconds */
  responseTime: number;
  /** Tokens per second */
  tokensPerSecond: number;
  /** Context window size used */
  contextSize: number;
  /** Memory mode */
  memoryMode: string;
  /** Layers offloaded to GPU */
  gpuLayers: number;
  /** Timestamp of test */
  timestamp: Date;
}

/**
 * Interface for available models
 */
export interface IAvailableModels {
  /** List of available model names */
  models: string[];
  /** Default model name */
  defaultModel: string;
  /** Base path for models */
  modelsPath: string;
}
