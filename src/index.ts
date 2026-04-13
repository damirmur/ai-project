import 'dotenv/config';
import { getConfig } from '@/config/llm.config.js';
import { LLMService } from '@services/llm.service.js';
import { LogService } from '@services/log.service.js';
import { QuestionService } from '@services/question.service.js';
import type { ITestResult } from '@types-def/llm.types.js';

/**
 * Main application entry point
 */
async function main(): Promise<void> {
  // Get model name from command line argument or use default
  const modelName = process.argv[2];
  const config = getConfig(modelName);

  // Initialize services
  const logService = new LogService(config.logFilePath);
  const llmService = new LLMService();
  const questionService = new QuestionService();

  try {
    logService.log('Starting LLM Test');
    logService.log(`Model: ${config.modelName}`);
    logService.log(`Model Path: ${config.modelPath}`);

    // Load model
    await llmService.loadModel(config.modelPath, config.contextSize);

    // Get model info
    const modelInfo = llmService.getModelInfo();
    if (modelInfo) {
      logService.logModelInfo({
        name: modelInfo.name,
        path: modelInfo.filePath
      });
    }

    // Get context size from service (actual from node-llama-cpp LlamaContext)
    const actualContextSize = llmService.getActualContextSize() ?? 0;

    // Get random question
    const question = questionService.getRandomQuestion();
    logService.log(`\nQuestion: ${question}`);

    // Generate response with streaming
    const startTime = Date.now();
    let fullResponse = '';

    console.log('\n--- MODEL RESPONSE START ---');

    const response = await llmService.generateStreamingResponse(question, (token) => {
      // Stream token to terminal immediately
      process.stdout.write(token);
      fullResponse += token;
    });

    console.log('\n--- MODEL RESPONSE END ---\n');
    
    const endTime = Date.now();
    const responseTime = endTime - startTime;

    // Calculate approximate tokens per second (rough estimate)
    const trimmedResponse = response.trim();
    const approximateTokens = trimmedResponse ? trimmedResponse.split(/\s+/).length : 0;
    const tokensPerSecond = responseTime > 0 ? (approximateTokens / responseTime) * 1000 : 0;

    // Create test result
    const testResult: ITestResult = {
      modelName: config.modelName,
      question,
      response,
      responseTime,
      tokensPerSecond,
      contextSize: actualContextSize,
      memoryMode: 'default',
      gpuLayers: llmService.getGpuLayers(),
      timestamp: new Date()
    };

    // Log test result
    logService.logTestResult(testResult);

    // Output to terminal
    console.log('\n========================================');
    console.log('TEST COMPLETED');
    console.log('========================================');
    console.log(`Model: ${testResult.modelName}`);
    console.log(`Question: ${testResult.question}`);
    console.log(`Response Time: ${testResult.responseTime}ms`);
    console.log(`Approximate Tokens/Second: ${testResult.tokensPerSecond.toFixed(2)}`);
    console.log(`Context Size: ${testResult.contextSize}`);
    console.log(`Memory Mode: ${testResult.memoryMode}`);
    console.log(`GPU Layers: ${testResult.gpuLayers}`);
    console.log('========================================\n');

  } catch (error) {
    logService.error(error instanceof Error ? error : String(error));
    console.error('Error during execution:', error);
    process.exit(1);
  } finally {
    // Clear memory and exit
    try {
      await llmService.clearMemory();
      await logService.close();
      process.exit(0);
    } catch (error) {
      console.error('Error during cleanup:', error);
      process.exit(1);
    }
  }
}

// Run main function
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
