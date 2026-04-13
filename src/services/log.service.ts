import * as fs from 'fs';
import * as path from 'path';
import type { ITestResult } from '@types-def/llm.types.js';
import type { ILogService, LogLevel } from '@types-def/services.types.js';

export class LogService implements ILogService {
  private logFilePath: string;

  constructor(logFilePath: string) {
    this.logFilePath = logFilePath;
    this.initLogFile();
  }

  /**
   * Initialize log file
   */
  private initLogFile(): void {
    // Ensure directory exists
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.syncLog('=== LLM Test Log Started ===');
    this.syncLog(`Timestamp: ${new Date().toISOString()}`);
    this.syncLog('================================');
  }

  /**
   * Synchronous log write to ensure data is saved
   */
  private syncLog(message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [INFO] ${message}\n`;
    fs.appendFileSync(this.logFilePath, logMessage);
    console.log(message);
  }

  /**
   * Log a message to file and optionally console
   */
  log(message: string, level: LogLevel = 'info'): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

    fs.appendFileSync(this.logFilePath, logMessage);
    console.log(message);
  }

  /**
   * Log an error
   */
  error(error: string | Error): void {
    const errorMessage = error instanceof Error ? error.stack || error.message : error;
    this.log(`ERROR: ${errorMessage}`, 'error');
  }

  /**
   * Log model information
   */
  logModelInfo(info: Record<string, unknown>): void {
    this.log('=== Model Information ===');
    Object.entries(info).forEach(([key, value]) => {
      this.log(`${key}: ${value}`);
    });
    this.log('========================');
  }

  /**
   * Log test result
   */
  logTestResult(result: ITestResult): void {
    this.log('=== Test Result ===');
    this.log(`Model: ${result.modelName}`);
    this.log(`Question: ${result.question}`);
    this.log('--- Model Response START ---');
    this.log(result.response || '(empty response)');
    this.log('--- Model Response END ---');
    this.log(`Response Time: ${result.responseTime}ms`);
    this.log(`Tokens/Second: ${result.tokensPerSecond.toFixed(2)}`);
    this.log(`Context Size: ${result.contextSize}`);
    this.log(`Memory Mode: ${result.memoryMode}`);
    this.log(`GPU Layers: ${result.gpuLayers}`);
    this.log(`Timestamp: ${result.timestamp.toISOString()}`);
    this.log('===================');
  }

  /**
   * Close log file
   */
  async close(): Promise<void> {
    this.syncLog('=== Log Ended ===');
  }
}
