import 'dotenv/config';
import { getAvailableModels } from '@/config/llm.config.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Number of cycles to run (each cycle runs through all available models)
 */
const CYCLES = 3;

/**
 * Test log file path
 */
const TEST_LOG_FILE = path.join(process.cwd(), 'test-runner.log');

/**
 * Interface for test results
 */
interface ModelTestResult {
  modelName: string;
  cycle: number;
  success: boolean;
  question?: string;
  response?: string;
  responseTime?: string;
  tokensPerSecond?: string;
  contextSize?: string;
  error?: string;
  duration: number;
}

/**
 * Write to test log file
 */
function testLog(message: string, toConsole: boolean = true): void {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(TEST_LOG_FILE, logMessage);
  if (toConsole) {
    console.log(message);
  }
}

/**
 * Run a single test with a specific model
 */
async function runModelTest(modelName: string, cycle: number): Promise<ModelTestResult> {
  const result: ModelTestResult = {
    modelName,
    cycle,
    success: false,
    duration: 0
  };

  const startTime = Date.now();

  return new Promise((resolve) => {
    testLog(`\n${'─'.repeat(80)}`);
    testLog(`🔄 ЗАГРУЗКА МОДЕЛИ: ${modelName} (Цикл ${cycle}/${CYCLES})`);
    testLog(`${'─'.repeat(80)}`);

    // Spawn the main application process (same as npm start)
    const child = spawn('node', [
      '-r', 'tsconfig-paths/register',
      'dist/index.js',
      modelName
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let inResponseSection = false;

    // Capture stdout
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;

      // Detect response section
      if (text.includes('--- MODEL RESPONSE START ---')) {
        inResponseSection = true;
        testLog('\n💬 ОТВЕТ МОДЕЛИ (начало):');
        return;
      }

      if (text.includes('--- MODEL RESPONSE END ---')) {
        inResponseSection = false;
        testLog('💬 ОТВЕТ МОДЕЛИ (конец)\n');
        return;
      }

      // Print response tokens in real-time
      if (inResponseSection) {
        process.stdout.write(text);
        return;
      }

      // Print other output (loading info, stats, etc)
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (line.includes('Model:') || line.includes('Model Path:') || 
            line.includes('Starting LLM') || line.includes('Question:') ||
            line.includes('Response Time:') || line.includes('Tokens/Second:') ||
            line.includes('Context Size:') || line.includes('TEST COMPLETED') ||
            line.includes('Available memory:') || line.includes('Memory for context:') ||
            line.includes('Context size:')) {
          testLog('   ' + line);
        }
      }
    });

    // Capture stderr
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
    });

    // Process exit
    child.on('close', (code) => {
      const endTime = Date.now();
      result.duration = endTime - startTime;

      if (code === 0) {
        result.success = true;

        // Parse test results from output
        const questionMatch = stdout.match(/Question:\s*(.+)/);
        const responseTimeMatch = stdout.match(/Response Time:\s*(.+)/);
        const tokensPerSecondMatch = stdout.match(/Approximate Tokens\/Second:\s*(.+)/);
        const contextSizeMatch = stdout.match(/Context Size:\s*(.+)/);

        if (questionMatch) {
          result.question = questionMatch[1].trim();
        }

        if (responseTimeMatch) {
          result.responseTime = responseTimeMatch[1].trim();
        }

        if (tokensPerSecondMatch) {
          result.tokensPerSecond = tokensPerSecondMatch[1].trim();
        }

        if (contextSizeMatch) {
          result.contextSize = contextSizeMatch[1].trim();
        }

        // Extract full response
        const responseStart = stdout.indexOf('--- MODEL RESPONSE START ---');
        const responseEnd = stdout.indexOf('--- MODEL RESPONSE END ---');
        if (responseStart !== -1 && responseEnd !== -1) {
          result.response = stdout.substring(responseStart + 26, responseEnd).trim();
        }
      } else {
        result.success = false;
        result.error = stderr || `Процесс завершился с кодом ${code}`;
        testLog(`\n❌ ОШИБКА: модель не загрузилась (код: ${code})`);
        if (stderr) {
          testLog('   ' + stderr.split('\n').slice(0, 3).join('\n   '));
        }
      }

      resolve(result);
    });

    // Error handler
    child.on('error', (error) => {
      result.success = false;
      result.error = error.message;
      testLog(`\n❌ КРИТИЧЕСКАЯ ОШИБКА: ${error.message}`);
      resolve(result);
    });
  });
}

/**
 * Print test result summary
 */
function printResultSummary(result: ModelTestResult): void {
  testLog(`\n${'═'.repeat(80)}`);
  testLog(`📊 РЕЗУЛЬТАТ ТЕСТА`);
  testLog(`${'═'.repeat(80)}`);
  testLog(`Модель:        ${result.modelName}`);
  testLog(`Цикл:          ${result.cycle}/${CYCLES}`);
  testLog(`Статус:        ${result.success ? '✅ Успешно' : '❌ Провалено'}`);
  testLog(`Время теста:   ${Math.floor(result.duration / 1000)}с`);
  
  if (result.success) {
    if (result.question) {
      testLog(`\n❓ Вопрос:\n   ${result.question}`);
    }
    
    if (result.response) {
      const preview = result.response.length > 300 
        ? result.response.substring(0, 300) + '...' 
        : result.response;
      testLog(`\n💬 Ответ (превью):\n   ${preview.replace(/\n/g, '\n   ')}`);
    }
    
    if (result.responseTime) {
      testLog(`\n⏱️  Время ответа:    ${result.responseTime}`);
    }
    if (result.tokensPerSecond) {
      testLog(`🔢 Токенов/сек:     ${result.tokensPerSecond}`);
    }
    if (result.contextSize) {
      testLog(`📏 Размер контекста: ${result.contextSize}`);
    }
  } else if (result.error) {
    testLog(`\n❌ Ошибка:\n   ${result.error.split('\n').slice(0, 2).join('\n   ')}`);
  }
  
  testLog(`${'═'.repeat(80)}`);
}

/**
 * Print final summary table
 */
function printFinalSummary(results: ModelTestResult[]): void {
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);
  const successfulTests = results.filter(r => r.success).length;
  const failedTests = results.filter(r => !r.success).length;

  testLog(`\n\n${'█'.repeat(80)}`);
  testLog(`🏁 ИТОГОВАЯ СТАТИСТИКА`);
  testLog(`${'█'.repeat(80)}\n`);

  // Group by model
  const modelStats = new Map<string, { total: number; success: number; failed: number; avgTime: number }>();
  
  for (const result of results) {
    if (!modelStats.has(result.modelName)) {
      modelStats.set(result.modelName, { total: 0, success: 0, failed: 0, avgTime: 0 });
    }
    const stats = modelStats.get(result.modelName)!;
    stats.total++;
    if (result.success) stats.success++;
    else stats.failed++;
    stats.avgTime += result.duration;
  }

  // Print table
  testLog('Модель'.padEnd(45) + 'Успешно'.padEnd(12) + 'Провалено'.padEnd(12) + 'Ср. время');
  testLog('─'.repeat(80));
  
  for (const [modelName, stats] of modelStats) {
    const avgTimeSec = Math.floor((stats.avgTime / stats.total) / 1000);
    const shortName = modelName.length > 43 ? modelName.substring(0, 40) + '...' : modelName;
    testLog(
      shortName.padEnd(45) +
      stats.success.toString().padEnd(12) +
      stats.failed.toString().padEnd(12) +
      `${avgTimeSec}с`
    );
  }

  testLog(`\n${'─'.repeat(80)}`);
  testLog(`Всего тестов:      ${results.length}`);
  testLog(`✅ Успешно:         ${successfulTests}`);
  testLog(`❌ Провалено:       ${failedTests}`);
  testLog(`⏱️  Общее время:    ${Math.floor(totalTime / 1000)}с`);
  testLog(`📊 Циклов:          ${CYCLES}`);
  testLog(`📦 Моделей:         ${modelStats.size}`);
  testLog(`${'█'.repeat(80)}\n`);
}

/**
 * Main test runner
 */
async function main(): Promise<void> {
  // Clear test log file
  fs.writeFileSync(TEST_LOG_FILE, '');
  
  testLog('🚀 Запуск автоматического тестирования моделей LLM');
  testLog(`📊 Количество циклов: ${CYCLES}`);

  // Get available models
  const availableModels = getAvailableModels();
  const models = availableModels.models;

  if (models.length === 0) {
    testLog('❌ Модели не найдены в конфигурации!');
    process.exit(1);
  }

  testLog(`📦 Найдено моделей: ${models.length}`);
  models.forEach((model, index) => {
    testLog(`   ${index + 1}. ${model}`);
  });

  const allResults: ModelTestResult[] = [];
  const startTime = Date.now();

  // Run cycles
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    testLog(`\n\n${'█'.repeat(80)}`);
    testLog(`# ЦИКЛ ${cycle} ИЗ ${CYCLES}`);
    testLog(`${'█'.repeat(80)}`);

    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
      const modelName = models[modelIndex];
      
      // Run test (no delays)
      const result = await runModelTest(modelName, cycle);
      allResults.push(result);
      
      // Print result summary
      printResultSummary(result);
    }
  }

  const endTime = Date.now();
  const totalTime = ((endTime - startTime) / 1000 / 60).toFixed(2);

  // Print final summary
  printFinalSummary(allResults);

  testLog(`✅ Все тесты завершены!`);
  testLog(`⏱️  Общее время: ${totalTime} минут`);
  testLog(`📝 Лог сохранён в: ${TEST_LOG_FILE}`);
  testLog('');
}

// Run the test
main().catch((error) => {
  console.error('💥 Неожиданная ошибка:', error);
  process.exit(1);
});
