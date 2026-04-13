/**
 * Service interface for LLM operations
 */
export interface ILLMService {
  /**
   * Load a model from the specified path
   * @param modelPath Path to the model file
   * @param contextSize Optional context size configuration
   */
  loadModel(modelPath: string, contextSize?: ContextSize): Promise<void>;

  /**
   * Get the current context size configuration
   * @returns Context size configuration
   */
  getContextSize(): ContextSize;

  /**
   * Get the actual context size from the loaded LlamaContext
   * @returns Actual context size in tokens, or null if no model loaded
   */
  getActualContextSize(): number | null;

  /**
   * Generate a response from the model
   * @param prompt The input prompt
   * @returns The model's response
   */
  generateResponse(prompt: string): Promise<string>;

  /**
   * Generate a streaming response from the model
   * @param prompt The input prompt
   * @param onToken Callback for each token generated
   * @returns The model's full response
   */
  generateStreamingResponse(
    prompt: string,
    onToken: (token: string) => void
  ): Promise<string>;

  /**
   * Get model information
   * @returns Current model information
   */
  getModelInfo(): IModelInfo | null;

  /**
   * Clear model memory and unload
   */
  clearMemory(): Promise<void>;
}

/**
 * Service interface for logging
 */
export interface ILogService {
  /**
   * Log a message to file and optionally console
   * @param message Message to log
   * @param level Log level
   */
  log(message: string, level?: LogLevel): void;

  /**
   * Log an error
   * @param error Error message or object
   */
  error(error: string | Error): void;

  /**
   * Log model information
   * @param info Model information
   */
  logModelInfo(info: Record<string, unknown>): void;

  /**
   * Log test result
   * @param result Test result
   */
  logTestResult(result: ITestResult): void;

  /**
   * Close log file
   */
  close(): Promise<void>;
}

/**
 * Service interface for question generation
 */
export interface IQuestionService {
  /**
   * Get a random question from the predefined list
   * @returns A random question
   */
  getRandomQuestion(): string;
}

import type { IModelInfo, ITestResult, ContextSize } from '@types-def/llm.types.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
