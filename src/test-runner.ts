import 'dotenv/config';
import { getAvailableModels } from '@/config/llm.config.js';
import { QuestionService } from '@services/question.service.js';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// ============================================================================
// TYPES
// ============================================================================

interface TestConfig {
  cycles: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  memoryLimitMB: number;
  memoryCheckIntervalMs: number;
  testQuestions: string[];
  retryOnFail: number;
  outputDir: string;
  /** Резерв памяти для супервизора (МБ) */
  supervisorMemoryReserveMB: number;
}

interface ModelTestResult {
  modelName: string;
  cycle: number;
  question: string;
  success: boolean;
  responseTimeMs?: number;
  tokensPerSecond?: number;
  contextSize?: number;
  peakMemoryMB?: number;
  ttftMs?: number;
  responseLength?: number;
  /** Полный текст ответа модели */
  fullResponse?: string;
  error?: string;
  errorType?: 'timeout' | 'idle' | 'oom' | 'crash' | 'unknown';
  duration: number;
  timestamp: string;
}

interface ModelSummary {
  modelName: string;
  totalTests: number;
  successful: number;
  failed: number;
  avgResponseTimeMs: number;
  avgTokensPerSecond: number;
  avgPeakMemoryMB: number;
  avgTtftMs: number;
}

interface ModelRating {
  /** Кто оценивает (модель-оценщик) */
  evaluator: string;
  /** Кого оценивают */
  targetModel: string;
  /** Балл 1-10 */
  score: number;
  /** Критерий оценки */
  criterion: string;
  /** Комментарий (пояснение) */
  comment: string;
}

interface SelfEvalResult {
  modelName: string;
  response: string;
  success: boolean;
  duration: number;
  /** Распарсенные оценки (если удалось извлечь) */
  ratings: ModelRating[];
  /** Общий вывод лучшей модели */
  bestModelPick: string;
  /** Предложенные улучшения */
  improvements: string[];
}

interface TestReport {
  summary: {
    totalTests: number;
    successful: number;
    failed: number;
    totalDurationMs: number;
    totalDurationHuman: string;
    models: Record<string, ModelSummary>;
  };
  results: ModelTestResult[];
  selfEvaluation: SelfEvalResult[];
  config: TestConfig;
  timestamp: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CONFIG: TestConfig = {
  cycles: 1, // 1 цикл → self-evaluation с результатами
  timeoutMs: 600_000, // 10 минут — абсолютный максимум (2 вопроса на тест)
  idleTimeoutMs: 60_000, // 60 секунд без активности = idle timeout
  memoryLimitMB: 0, // Рассчитывается динамически при запуске
  memoryCheckIntervalMs: 2000,
  testQuestions: [], // Заполняется из QuestionService
  retryOnFail: 0,
  outputDir: path.join(process.cwd(), 'test-results'),
  supervisorMemoryReserveMB: 300 // Резерв для работы супервизора
};

/**
 * Pre-question about library knowledge — asked before the main question
 */
const PRE_QUESTION = 'Знаешь ли ты библиотеки node-llama-cpp, langgraph и langchain.js? Если да — какие последние версии этих библиотек тебе известны?';

/**
 * Magic numbers extracted to constants
 */
const MAX_RESPONSE_PREVIEW = 2000;
const MAX_EXAMPLE_RESPONSES = 3;
const SUDO_COMMAND_TIMEOUT_MS = 30_000; // 30 секунд на sudo команды
const KILL_FALLBACK_TIMEOUT_MS = 5_000; // 5 секунд ждать SIGTERM, потом SIGKILL
const MARKER_RESPONSE_START = '--- MODEL RESPONSE START ---';
const MARKER_RESPONSE_END = '--- MODEL RESPONSE END ---';
const MIN_QUESTIONS_WARNING = 3;
const MEMORY_MARKER = 'MemAvailable:\\s+(\\d+)';

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Get available system memory in MB
 */
function getAvailableMemoryMB(): number {
  try {
    if (os.platform() === 'linux') {
      const meminfo = execSync('cat /proc/meminfo').toString();
      const memAvailableMatch = meminfo.match(new RegExp(MEMORY_MARKER));
      if (memAvailableMatch) {
        return Math.floor(parseInt(memAvailableMatch[1], 10) / 1024);
      }
    }
  } catch {
    // Fallback
  }
  return Math.floor(os.totalmem() / (1024 * 1024));
}

/**
 * Calculate memory limit for model testing
 * Uses all available memory minus supervisor reserve
 */
function calculateMemoryLimitMB(reserveMB: number): number {
  const availableMB = getAvailableMemoryMB();
  const limitMB = availableMB - reserveMB;
  return Math.max(limitMB, 1024); // Минимум 1 ГБ
}

/**
 * Try to free memory before launching a model test
 * Attempts to push other processes to swap and clear caches
 * Returns info about what was attempted
 */
function tryFreeMemoryBeforeTest(logger: Logger): string[] {
  const attempts: string[] = [];
  let sudoAvailable = true;

  // 1. Sync filesystem buffers (always works, no root needed)
  try {
    execSync('sync', { timeout: 5000 });
    attempts.push('✅ sync: буферы сброшены на диск');
  } catch (e) {
    attempts.push('❌ sync: не удалось');
  }

  // 2. Drop page caches (needs sudo)
  if (sudoAvailable) {
    try {
      execSync('sudo sh -c "echo 3 > /proc/sys/vm/drop_caches"', {
        stdio: 'pipe',
        timeout: SUDO_COMMAND_TIMEOUT_MS
      });
      attempts.push('✅ drop_caches: page cache очищен (sudo)');
    } catch {
      sudoAvailable = false;
      attempts.push('⚠️  drop_caches: sudo недоступен — пропуск sudo команд');
    }
  }

  // 3. Increase swappiness temporarily (needs sudo)
  if (sudoAvailable) {
    try {
      execSync('sudo sysctl -w vm.swappiness=100', {
        stdio: 'pipe',
        timeout: SUDO_COMMAND_TIMEOUT_MS
      });
      attempts.push('✅ swappiness: увеличен до 100 (агрессивный своп)');
    } catch {
      sudoAvailable = false;
      attempts.push('⚠️  swappiness: sudo недоступен — пропуск sudo команд');
    }
  }

  // 4. Try to trigger memory reclaim
  if (sudoAvailable) {
    try {
      execSync('sudo sh -c "echo 1 > /proc/sys/vm/compact_memory"', {
        stdio: 'pipe',
        timeout: SUDO_COMMAND_TIMEOUT_MS
      });
      attempts.push('✅ compact_memory: дефрагментация памяти');
    } catch {
      sudoAvailable = false;
      attempts.push('⚠️  compact_memory: sudo недоступен — пропуск sudo команд');
    }
  }

  if (!sudoAvailable) {
    attempts.push('ℹ️  Последующие sudo команды пропущены (пароль неверен или sudo недоступен)');
  }

  const availableAfter = getAvailableMemoryMB();
  attempts.push(`📊 Доступно памяти: ${availableAfter}MB`);

  return attempts;
}

/**
 * Get process RSS memory in MB by PID
 */
function getProcessMemoryMB(pid: number): number {
  try {
    const output = execSync(`ps -o rss= -p ${pid}`).toString().trim();
    return Math.floor(parseInt(output, 10) / 1024); // KB -> MB
  } catch {
    return 0;
  }
}

/**
 * Format milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Get next question from rotation (round-robin)
 */
function getNextQuestion(questionIndex: number, questions: string[]): string {
  return questions[questionIndex % questions.length];
}

/**
 * Extract response text between START and END markers
 */
function extractResponse(stdout: string): string | null {
  const responseStart = stdout.indexOf(MARKER_RESPONSE_START);
  const responseEnd = stdout.indexOf(MARKER_RESPONSE_END);
  if (responseStart !== -1 && responseEnd !== -1 && responseEnd > responseStart) {
    return stdout.substring(responseStart + MARKER_RESPONSE_START.length, responseEnd).trim();
  }
  return null;
}

/**
 * Response quality metrics
 */
interface ResponseQuality {
  /** Ответ обрывается на полуслове (нет завершающего знака препинания) */
  endsAbruptly: boolean;
  /** Ответ пустой */
  isEmpty: boolean;
  /** Содержит блоки кода */
  hasCode: boolean;
  /** Длина ответа */
  charLength: number;
  /** Оценка длины (0-10) */
  lengthScore: number;
}

/**
 * Evaluate response quality automatically
 */
function evaluateResponseQuality(response: string): ResponseQuality {
  const trimmed = response.trim();
  const charLength = trimmed.length;

  // Check if ends abruptly (no ending punctuation or closing marker)
  const endingPunctuation = /[.!?。！？」』\)"\n]$/;
  const endsAbruptly = charLength > 10 && !endingPunctuation.test(trimmed);

  // Check if empty
  const isEmpty = charLength === 0;

  // Check for code blocks
  const hasCode = trimmed.includes('```') || trimmed.includes('<code>') || /^\s{4}\w/m.test(trimmed);

  // Length score (heuristic: 200+ chars = good, 1000+ = excellent)
  let lengthScore = 0;
  if (charLength > 0) lengthScore = 1;
  if (charLength > 50) lengthScore = 2;
  if (charLength > 100) lengthScore = 3;
  if (charLength > 200) lengthScore = 4;
  if (charLength > 400) lengthScore = 5;
  if (charLength > 600) lengthScore = 6;
  if (charLength > 800) lengthScore = 7;
  if (charLength > 1200) lengthScore = 8;
  if (charLength > 2000) lengthScore = 9;
  if (charLength > 3000) lengthScore = 10;

  return { endsAbruptly, isEmpty, hasCode, charLength, lengthScore };
}

/**
 * Calculate tokens more accurately (word-based with punctuation handling)
 */
function calculateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Split by whitespace, filter empty strings, count punctuation as separate tokens
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  let tokenCount = words.length;
  // Add tokens for punctuation marks within words
  for (const word of words) {
    const punctCount = (word.match(/[.,!?;:()'"—–\-]/g) || []).length;
    tokenCount += punctCount;
  }
  return tokenCount;
}

/**
 * Parse self-evaluation response to extract structured ratings
 * Only accepts ratings that reference actual model names from allModelNames
 */
function parseSelfEvalRatings(evaluatorName: string, response: string, allModelNames: string[]): {
  ratings: ModelRating[];
  bestModelPick: string;
  improvements: string[];
} {
  const ratings: ModelRating[] = [];
  const improvements: string[] = [];
  let bestModelPick = '';

  const lines = response.split('\n');
  let inImprovements = false;

  // Known criteria names (Russian)
  const criteriaPatterns = [
    { key: 'корректност', name: 'Корректность кода' },
    { key: 'обработка ошибок', name: 'Обработка ошибок' },
    { key: 'типизац', name: 'Типизация TypeScript' },
    { key: 'архитектур', name: 'Архитектурные решения' },
    { key: 'развёрнутост', name: 'Развёрнутость объяснений' },
    { key: 'законченност', name: 'Законченность ответов' },
    { key: 'общ', name: 'Общая оценка' },
  ];

  // Placeholder strings to ignore
  const placeholderPatterns = ['ModelA', 'ModelB', 'ModelC', 'хороший код, но'];

  // Determine current criterion from context (scan backwards for last heading)
  let currentCriterion = 'Общая оценка';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Detect improvements section
    if (/предложен|улучшен|improvement/i.test(line.toLowerCase())) {
      inImprovements = true;
      continue;
    }

    // Detect section headings (#### X)
    const headingMatch = line.match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      const headingText = headingMatch[1].toLowerCase();
      for (const cp of criteriaPatterns) {
        if (headingText.includes(cp.key)) {
          currentCriterion = cp.name;
          break;
        }
      }
      // Check for best model / improvements headings
      if (/лучш|best model/i.test(headingText)) {
        inImprovements = false;
      }
      if (/предложен|улучшен|improvement/i.test(headingText)) {
        inImprovements = true;
      }
      continue;
    }

    // Collect improvement items
    if (inImprovements) {
      if (line.startsWith('-') || line.startsWith('*') || /^\d+[.)]/.test(line)) {
        const impText = line.replace(/^[-*\d.)]\s*/, '').trim();
        if (impText.length > 3) improvements.push(impText);
      }
      continue;
    }

    // Detect best model section from text
    if (/лучш[aяя]+ модель/i.test(line)) {
      for (const mName of allModelNames) {
        if (line.includes(mName)) {
          bestModelPick = mName;
          break;
        }
      }
      if (!bestModelPick) {
        // Try to extract from next line
        bestModelPick = line.replace(/^[-–—•*]\s*/, '').trim();
      }
      continue;
    }

    // Try to parse rating line: - modelName: X/10 — comment
    // or: modelName: X/10 — comment
    const ratingMatch = line.match(
      /^[-*]?\s*([a-zA-Z0-9_.\-\s]+?)\s*[:=]\s*(\d+)\s*\/\s*10\s*[-–—:]?\s*(.*)/
    );

    if (ratingMatch) {
      let rawName = ratingMatch[1].trim();
      const score = parseInt(ratingMatch[2], 10);
      const comment = ratingMatch[3]?.trim() || '';

      // Skip placeholders
      if (placeholderPatterns.some(p => rawName.toLowerCase().includes(p.toLowerCase()) || comment.toLowerCase().includes(p.toLowerCase()))) {
        continue;
      }

      // Skip if score is not 1-10
      if (score < 1 || score > 10) continue;

      // Match to actual model name
      let matchedModel = '';
      for (const mName of allModelNames) {
        if (mName === rawName || rawName.includes(mName) || mName.includes(rawName)) {
          matchedModel = mName;
          break;
        }
        // Fuzzy: check if first 15 chars match
        if (mName.substring(0, 15) === rawName.substring(0, 15)) {
          matchedModel = mName;
          break;
        }
      }

      // Only accept if we matched a real model
      if (matchedModel) {
        ratings.push({
          evaluator: evaluatorName,
          targetModel: matchedModel,
          score,
          criterion: currentCriterion,
          comment
        });
      }
    }
  }

  return { ratings, bestModelPick, improvements };
}

// ============================================================================
// PROGRESS BAR
// ============================================================================

class ProgressBar {
  private width: number;

  constructor(width: number = 40) {
    this.width = width;
  }

  render(current: number, total: number, label: string = ''): void {
    const percent = total > 0 ? current / total : 0;
    const filled = Math.round(this.width * percent);
    const empty = this.width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const pct = `${(percent * 100).toFixed(1)}%`;
    const text = label ? ` ${label}` : '';
    process.stdout.write(`\r${bar} ${pct} (${current}/${total})${text}`);
  }

  clear(): void {
    process.stdout.write('\n');
  }
}

// ============================================================================
// LOGGING
// ============================================================================

class Logger {
  private logFile: string;

  constructor(logFile: string) {
    this.logFile = logFile;
    fs.writeFileSync(this.logFile, '');
  }

  log(message: string, toConsole: boolean = true): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(this.logFile, logMessage);
    if (toConsole) {
      console.log(message);
    }
  }

  separator(char: string = '─', length: number = 80): void {
    this.log(char.repeat(length));
  }

  boldSeparator(char: string = '█', length: number = 80): void {
    this.log(char.repeat(length));
  }
}

// ============================================================================
// MEMORY MONITOR
// ============================================================================

class MemoryMonitor {
  private pid: number | null = null;
  private peakMemoryMB: number = 0;
  private monitorInterval: NodeJS.Timeout | null = null;
  private limitMB: number;
  private onLimitExceeded: () => void;
  private logger: Logger;

  constructor(limitMB: number, onLimitExceeded: () => void, logger: Logger) {
    this.limitMB = limitMB;
    this.onLimitExceeded = onLimitExceeded;
    this.logger = logger;
  }

  start(pid: number): void {
    this.pid = pid;
    this.peakMemoryMB = 0;

    this.monitorInterval = setInterval(() => {
      if (!this.pid) return;

      const currentMemory = getProcessMemoryMB(this.pid);
      if (currentMemory > this.peakMemoryMB) {
        this.peakMemoryMB = currentMemory;
      }

      if (currentMemory > this.limitMB) {
        this.logger.log(`⚠️  Превышен лимит памяти: ${currentMemory}MB > ${this.limitMB}MB`);
        this.onLimitExceeded();
      }
    }, 2000);
  }

  stop(): number {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    return this.peakMemoryMB;
  }
}

// ============================================================================
// TIMEOUT MANAGER
// ============================================================================

class TimeoutManager {
  private totalTimeoutHandle: NodeJS.Timeout | null = null;
  private idleTimeoutHandle: NodeJS.Timeout | null = null;
  private totalTimeoutMs: number;
  private idleTimeoutMs: number;
  private onTimeout: (type: 'total' | 'idle') => void;

  constructor(
    totalTimeoutMs: number,
    idleTimeoutMs: number,
    onTimeout: (type: 'total' | 'idle') => void
  ) {
    this.totalTimeoutMs = totalTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.onTimeout = onTimeout;
  }

  start(): void {
    // Total timeout — абсолютный максимум
    this.totalTimeoutHandle = setTimeout(() => {
      this.onTimeout('total');
    }, this.totalTimeoutMs);

    // Idle timeout — таймаут без активности
    this.resetIdleTimeout();
  }

  /**
   * Вызывать при каждой генерации токена (активность)
   */
  resetIdleTimeout(): void {
    if (this.idleTimeoutHandle) {
      clearTimeout(this.idleTimeoutHandle);
    }
    this.idleTimeoutHandle = setTimeout(() => {
      this.onTimeout('idle');
    }, this.idleTimeoutMs);
  }

  cancel(): void {
    if (this.totalTimeoutHandle) {
      clearTimeout(this.totalTimeoutHandle);
      this.totalTimeoutHandle = null;
    }
    if (this.idleTimeoutHandle) {
      clearTimeout(this.idleTimeoutHandle);
      this.idleTimeoutHandle = null;
    }
  }
}

// ============================================================================
// RESULT COLLECTOR
// ============================================================================

class ResultCollector {
  private results: ModelTestResult[] = [];

  addResult(result: ModelTestResult): void {
    this.results.push(result);
  }

  getResults(): ModelTestResult[] {
    return this.results;
  }

  getSummary(): Record<string, ModelSummary> {
    const modelMap = new Map<string, ModelTestResult[]>();

    for (const r of this.results) {
      if (!modelMap.has(r.modelName)) {
        modelMap.set(r.modelName, []);
      }
      modelMap.get(r.modelName)!.push(r);
    }

    const summary: Record<string, ModelSummary> = {};

    for (const [modelName, results] of modelMap) {
      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

      const avgResponseTimeMs = successful.length > 0
        ? Math.round(successful.reduce((sum, r) => sum + (r.responseTimeMs ?? 0), 0) / successful.length)
        : 0;

      const avgTokensPerSecond = successful.length > 0
        ? parseFloat((successful.reduce((sum, r) => sum + (r.tokensPerSecond ?? 0), 0) / successful.length).toFixed(2))
        : 0;

      const avgPeakMemoryMB = successful.length > 0
        ? Math.round(successful.reduce((sum, r) => sum + (r.peakMemoryMB ?? 0), 0) / successful.length)
        : 0;

      const avgTtftMs = successful.length > 0
        ? Math.round(successful.reduce((sum, r) => sum + (r.ttftMs ?? 0), 0) / successful.length)
        : 0;

      summary[modelName] = {
        modelName,
        totalTests: results.length,
        successful: successful.length,
        failed: failed.length,
        avgResponseTimeMs,
        avgTokensPerSecond,
        avgPeakMemoryMB,
        avgTtftMs
      };
    }

    return summary;
  }
}

// ============================================================================
// REPORT GENERATOR
// ============================================================================

class ReportGenerator {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  generateMarkdown(report: TestReport): string {
    const lines: string[] = [];

    lines.push('# 🧪 LLM Model Test Report\n');
    lines.push(`**Date:** ${new Date(report.timestamp).toLocaleString()}\n`);
    lines.push(`**Config:** ${report.config.cycles} cycles, ${report.config.timeoutMs / 1000}s timeout, ${report.config.memoryLimitMB}MB memory limit\n`);

    // Summary
    lines.push('## 📊 Summary\n');
    lines.push(`- **Total Tests:** ${report.summary.totalTests}`);
    lines.push(`- **Successful:** ${report.summary.successful}`);
    lines.push(`- **Failed:** ${report.summary.failed}`);
    lines.push(`- **Total Duration:** ${report.summary.totalDurationHuman}\n`);

    // Model table
    lines.push('## 🏆 Model Performance\n');
    lines.push('| Model | Tests | ✅ | ❌ | Avg Response | Tokens/s | Peak Mem | TTFT |');
    lines.push('|-------|-------|----|----|-------------|----------|----------|------|');

    for (const [modelName, stats] of Object.entries(report.summary.models)) {
      const shortName = modelName.length > 30 ? modelName.substring(0, 27) + '...' : modelName;
      lines.push(
        `| ${shortName} | ${stats.totalTests} | ${stats.successful} | ${stats.failed} | ${stats.avgResponseTimeMs}ms | ${stats.avgTokensPerSecond} | ${stats.avgPeakMemoryMB}MB | ${stats.avgTtftMs}ms |`
      );
    }

    // Detailed results
    lines.push('\n## 📋 Detailed Results\n');

    for (const result of report.results) {
      lines.push(`### ${result.modelName} (Cycle ${result.cycle})\n`);
      lines.push(`- **Status:** ${result.success ? '✅ Success' : '❌ Failed'}`);
      lines.push(`- **Question:** ${result.question}`);

      if (result.success) {
        lines.push(`- **Response Time:** ${result.responseTimeMs}ms`);
        lines.push(`- **Tokens/s:** ${result.tokensPerSecond}`);
        lines.push(`- **Context Size:** ${result.contextSize}`);
        lines.push(`- **Peak Memory:** ${result.peakMemoryMB}MB`);
        lines.push(`- **TTFT:** ${result.ttftMs}ms`);

        // Quality metrics
        if (result.fullResponse) {
          const quality = evaluateResponseQuality(result.fullResponse);
          lines.push(`- **Quality:** length=${quality.charLength} chars, score=${quality.lengthScore}/10, code=${quality.hasCode}, abrupt=${quality.endsAbruptly}`);
        }
      } else {
        lines.push(`- **Error Type:** ${result.errorType}`);
        lines.push(`- **Error:** ${result.error}`);
      }

      lines.push('');
    }

    // ============================================================================
    // SELF-EVALUATION: сначала сводная таблица, потом детально
    // ============================================================================
    if (report.selfEvaluation && report.selfEvaluation.length > 0) {
      lines.push('\n\n═══════════════════════════════════════════════════════\n');
      lines.push('# 🧠 SELF-EVALUATION\n');

      const allModelNames = [...new Set(report.selfEvaluation.map(e => e.modelName))];

      // ──────────────────────────────────────────────────────────────────
      // СВОДНЫЙ ОТЧЁТ: таблица средних баллов по каждому критерию
      // ──────────────────────────────────────────────────────────────────
      lines.push('## 📊 Сводная таблица оценок\n');
      lines.push('> Кто → кого оценил | Средний балл по критериям (без пояснений)\n');

      // All ratings collected
      const allRatings = report.selfEvaluation.flatMap(e => e.ratings);

      if (allRatings.length > 0) {
        // Group by evaluator → target → criterion
        const evalMap = new Map<string, Map<string, Map<string, number[]>>>();

        for (const r of allRatings) {
          if (!evalMap.has(r.evaluator)) evalMap.set(r.evaluator, new Map());
          const targetMap = evalMap.get(r.evaluator)!;
          if (!targetMap.has(r.targetModel)) targetMap.set(r.targetModel, new Map());
          const critMap = targetMap.get(r.targetModel)!;
          if (!critMap.has(r.criterion)) critMap.set(r.criterion, []);
          critMap.get(r.criterion)!.push(r.score);
        }

        // Criteria list
        const allCriteria = [...new Set(allRatings.map(r => r.criterion))];

        // Summary: average per evaluator → target
        for (const [evaluator, targetMap] of evalMap) {
          lines.push(`\n### 📝 Оценщик: **${evaluator}**\n`);
          lines.push(`| Модель | ${allCriteria.join(' | ')} | Среднее |`);
          lines.push(`|--------|${allCriteria.map(() => '------:').join('|')}|--------:|`);

          for (const [targetModel, critMap] of targetMap) {
            const shortTarget = targetModel.length > 25 ? targetModel.substring(0, 22) + '...' : targetModel;
            const scores: number[] = [];
            const avgScores = allCriteria.map(crit => {
              const vals = critMap.get(crit) || [];
              const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
              scores.push(avg);
              return avg > 0 ? avg.toFixed(1) : '—';
            });
            const overallAvg = scores.length > 0 && scores.some(s => s > 0)
              ? (scores.reduce((a, b) => a + b, 0) / scores.filter(s => s > 0).length).toFixed(1)
              : '—';

            lines.push(`| ${shortTarget} | ${avgScores.join(' | ')} | ${overallAvg} |`);
          }
        }

        // ──────────────────────────────────────────────────────────────
        // СВОДНАЯ: Лучшая модель по мнению каждого оценщика
        // ──────────────────────────────────────────────────────────────
        lines.push('\n\n### 🏆 Лучшая модель (выбор каждого оценщика)\n');
        lines.push('| Оценщик | Лучшая модель |');
        lines.push('|---------|---------------|');

        for (const ev of report.selfEvaluation) {
          if (ev.bestModelPick) {
            const shortName = ev.bestModelPick.length > 35 ? ev.bestModelPick.substring(0, 32) + '...' : ev.bestModelPick;
            lines.push(`| ${ev.modelName} | ${shortName} |`);
          }
        }

        // ──────────────────────────────────────────────────────────────
        // СВОДНАЯ: Средний балл каждой модели (все оценщики вместе)
        // ──────────────────────────────────────────────────────────────
        lines.push('\n\n### 📈 Итоговый рейтинг моделей (среднее от всех оценщиков)\n');
        lines.push('| Модель | Ср. балл | Оценок |');
        lines.push('|--------|---------:|-------:|');

        const targetAvgMap = new Map<string, number[]>();
        for (const r of allRatings) {
          if (!targetAvgMap.has(r.targetModel)) targetAvgMap.set(r.targetModel, []);
          targetAvgMap.get(r.targetModel)!.push(r.score);
        }

        const sortedTargets = [...targetAvgMap.entries()].sort((a, b) => {
          const avgA = a[1].reduce((s, v) => s + v, 0) / a[1].length;
          const avgB = b[1].reduce((s, v) => s + v, 0) / b[1].length;
          return avgB - avgA;
        });

        for (const [targetModel, scores] of sortedTargets) {
          const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
          const shortTarget = targetModel.length > 35 ? targetModel.substring(0, 32) + '...' : targetModel;
          lines.push(`| ${shortTarget} | ${avg.toFixed(2)} | ${scores.length} |`);
        }
      } else {
        lines.push('⚠️  Не удалось автоматически извлечь структурированные оценки.');
        lines.push('Модели ответили свободным текстом. См. детальный отчёт ниже.\n');
      }

      // ──────────────────────────────────────────────────────────────────
      // ДЕТАЛЬНЫЙ ОТЧЁТ: полные оценки с пояснениями
      // ──────────────────────────────────────────────────────────────────
      lines.push('\n\n═══════════════════════════════════════════════════════\n');
      lines.push('# 📝 Детальные оценки моделей\n');
      lines.push('> Полный текст каждой модели-оценщика с пояснениями\n');

      for (const evalResult of report.selfEvaluation) {
        lines.push(`\n---\n`);
        lines.push(`## 📝 ${evalResult.modelName} (оценщик)\n`);
        lines.push(`- **Статус:** ${evalResult.success ? '✅ Успешно' : '❌ Ошибка'}`);
        lines.push(`- **Время оценки:** ${formatDuration(evalResult.duration)}`);

        if (evalResult.bestModelPick) {
          lines.push(`- **🏆 Лучшая модель:** ${evalResult.bestModelPick}`);
        }

        if (evalResult.improvements.length > 0) {
          lines.push(`- **Предложения по улучшению:**`);
          for (const imp of evalResult.improvements) {
            lines.push(`  - ${imp}`);
          }
        }

        if (evalResult.ratings.length > 0) {
          lines.push(`\n### Выставленные оценки:\n`);
          lines.push('| Критерий | Модель | Балл | Комментарий |');
          lines.push('|----------|--------|-----:|-------------|');
          for (const r of evalResult.ratings) {
            const shortTarget = r.targetModel.length > 20 ? r.targetModel.substring(0, 17) + '...' : r.targetModel;
            const shortComment = r.comment.length > 60 ? r.comment.substring(0, 57) + '...' : r.comment;
            lines.push(`| ${r.criterion} | ${shortTarget} | ${r.score}/10 | ${shortComment} |`);
          }
        }

        lines.push(`\n### Полный текст ответа:\n`);
        lines.push('```\n');
        lines.push(evalResult.response || '(нет ответа)');
        lines.push('\n```\n');
      }
    }

    return lines.join('\n');
  }

  generateJson(report: TestReport): string {
    return JSON.stringify(report, null, 2);
  }

  save(report: TestReport): { markdown: string; json: string } {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    const mdContent = this.generateMarkdown(report);
    const jsonContent = this.generateJson(report);

    const mdPath = path.join(this.outputDir, `report-${timestamp}.md`);
    const jsonPath = path.join(this.outputDir, `report-${timestamp}.json`);

    fs.writeFileSync(mdPath, mdContent);
    fs.writeFileSync(jsonPath, jsonContent);

    return { markdown: mdPath, json: jsonPath };
  }
}

// ============================================================================
// TEST ORCHESTRATOR
// ============================================================================

class TestOrchestrator {
  private config: TestConfig;
  private logger: Logger;
  private collector: ResultCollector;
  private reportGenerator: ReportGenerator;
  private currentProcess: ChildProcess | null = null;
  private isShuttingDown: boolean = false;
  private progressBar: ProgressBar;
  private selfEvalResults: SelfEvalResult[] = [];

  constructor(config: TestConfig) {
    this.config = config;
    const logFile = path.join(config.outputDir, 'supervisor.log');
    this.logger = new Logger(logFile);
    this.collector = new ResultCollector();
    this.reportGenerator = new ReportGenerator(config.outputDir);
    this.progressBar = new ProgressBar(50);

    // Graceful shutdown
    process.on('SIGINT', () => this.handleShutdown('SIGINT'));
    process.on('SIGTERM', () => this.handleShutdown('SIGTERM'));
  }

  private handleShutdown(signal: string): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.log(`\n🛑 Получен сигнал ${signal}. Завершение...`);

    if (this.currentProcess) {
      this.logger.log('⚠️  Завершение текущего процесса...');
      this.forceKillProcess(this.currentProcess);
    }

    // Generate partial report
    const results = this.collector.getResults();
    this.generateReport(results, Date.now());
    this.logger.log('📝 Частичный отчёт сохранён.');

    process.exit(130);
  }

  /**
   * Force kill process: SIGTERM → wait → SIGKILL
   */
  private forceKillProcess(child: ChildProcess): void {
    try {
      child.kill('SIGTERM');
      // If process doesn't exit after timeout, use SIGKILL
      setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process already exited
          }
        }
      }, KILL_FALLBACK_TIMEOUT_MS);
    } catch {
      // Process already exited
    }
  }

  /**
   * Validate input configuration
   */
  private validateConfig(models: string[], questions: string[]): void {
    if (models.length === 0) {
      this.logger.log('❌ Модели не найдены в конфигурации!');
      process.exit(1);
    }

    if (questions.length === 0) {
      this.logger.log('⚠️  Нет тестовых вопросов!');
      process.exit(1);
    }

    if (questions.length < MIN_QUESTIONS_WARNING) {
      this.logger.log(`⚠️  Мало вопросов: ${questions.length}. Рекомендуется минимум ${MIN_QUESTIONS_WARNING}`);
    }

    // Validate that dist/index.js exists
    const indexPath = path.join(process.cwd(), 'dist', 'index.js');
    if (!fs.existsSync(indexPath)) {
      this.logger.log(`❌ Файл dist/index.js не найден! Запустите сборку: npm run build`);
      process.exit(1);
    }
  }

  async run(): Promise<void> {
    const availableModels = getAvailableModels();
    const models = availableModels.models;

    // Validate inputs
    this.validateConfig(models, this.config.testQuestions);

    const totalTests = models.length * (this.config.cycles === -1 ? 1 : Math.max(this.config.cycles, 0));
    const availableMemory = getAvailableMemoryMB();

    this.logger.boldSeparator();
    this.logger.log('🚀 Запуск автоматического тестирования моделей LLM (СУПЕРВИЗОР)');
    this.logger.log(`📊 Циклов: ${this.config.cycles === -1 ? '∞ (бесконечный)' : this.config.cycles === 0 ? '0 (пропуск, сразу self-eval)' : this.config.cycles}`);
    this.logger.log(`📦 Моделей: ${models.length}`);
    this.logger.log(`📝 Вопросов: ${this.config.testQuestions.length}`);
    this.logger.log(`⏱️  Таймаут: ${this.config.timeoutMs / 1000}с`);
    this.logger.log(`💾 Доступная память: ${availableMemory}MB`);
    this.logger.log(`💾 Лимит памяти (доступная - ${this.config.supervisorMemoryReserveMB}MB резерв): ${this.config.memoryLimitMB}MB`);
    this.logger.boldSeparator();

    const startTime = Date.now();
    let questionIndex = 0;
    let cycle = 1;
    let completedTests = 0;

    // Циклы: -1 = бесконечный, 0 = пропустить, N = N циклов
    const isInfinite = this.config.cycles === -1;
    const skipCycles = this.config.cycles === 0;

    if (skipCycles) {
      this.logger.log('⏭️  Циклы пропущены — переход к self-evaluation');
    }

    while (isInfinite || (!skipCycles && cycle <= this.config.cycles)) {
      this.logger.boldSeparator();
      this.logger.log(`# ЦИКЛ ${cycle} ${isInfinite ? '(бесконечный режим)' : `ИЗ ${this.config.cycles}`}`);
      this.logger.boldSeparator();

      // В каждом цикле — одинаковый вопрос для всех моделей
      const question = getNextQuestion(questionIndex, this.config.testQuestions);
      questionIndex++;

      for (const modelName of models) {
        if (this.isShuttingDown) {
          this.logger.log('⚠️  Тестирование прервано пользователем');
          break;
        }

        // Попытаться освободить память перед запуском
        const freeMemAttempts = tryFreeMemoryBeforeTest(this.logger);
        for (const attempt of freeMemAttempts) {
          this.logger.log('   ' + attempt);
        }

        // Пересчитать лимит памяти после каждого процесса
        this.config.memoryLimitMB = calculateMemoryLimitMB(this.config.supervisorMemoryReserveMB);

        const result = await this.runModelTest(modelName, cycle, question);
        this.collector.addResult(result);
        completedTests++;

        // Update progress bar
        if (!isInfinite) {
          this.progressBar.render(completedTests, totalTests, `Тест ${modelName}`);
        }

        this.printResultSummary(result);
      }

      if (this.isShuttingDown) break;
      cycle++;
    }

    if (!isInfinite) {
      this.progressBar.clear();
    }

    // После циклов — SELF-EVALUATION: каждая модель анализирует результаты
    await this.runSelfEvaluation(models, cycle - 1, startTime);
  }

  private async runModelTest(modelName: string, cycle: number, question: string): Promise<ModelTestResult> {
    const result: ModelTestResult = {
      modelName,
      cycle,
      question,
      success: false,
      duration: 0,
      timestamp: new Date().toISOString()
    };

    const testStartTime = Date.now();

    return new Promise((resolve) => {
      this.logger.log(`\n${'─'.repeat(80)}`);
      this.logger.log(`🔄 ТЕСТ: ${modelName} (Цикл ${cycle}/${this.config.cycles})`);
      this.logger.log(`📚 Предварительный: ${PRE_QUESTION}`);
      this.logger.log(`❓ Основной вопрос: ${question}`);
      this.logger.log(`${'─'.repeat(80)}`);

      // Spawn child process
      const child = spawn('node', [
        '-r', 'tsconfig-paths/register',
        'dist/index.js',
        modelName
      ], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TEST_PRE_QUESTION: PRE_QUESTION }
      });

      this.currentProcess = child;
      let stdout = '';
      let stderr = '';
      let inResponseSection = false;
      let responseSectionStartTime = 0;
      let firstRealTokenReceived = false;

      // Memory monitor
      const memoryMonitor = new MemoryMonitor(
        this.config.memoryLimitMB,
        () => {
          if (child.pid && !result.error) {
            result.errorType = 'oom';
            result.error = `Превышен лимит памяти ${this.config.memoryLimitMB}MB`;
            this.forceKillProcess(child);
          }
        },
        this.logger
      );

      // Timeout manager
      const timeoutManager = new TimeoutManager(
        this.config.timeoutMs,
        this.config.idleTimeoutMs,
        (type) => {
          if (!result.success && !result.error) {
            if (type === 'idle') {
              result.errorType = 'idle';
              result.error = `Нет активности ${this.config.idleTimeoutMs / 1000}с`;
            } else {
              result.errorType = 'timeout';
              result.error = `Превышен абсолютный лимит ${this.config.timeoutMs / 1000}с`;
            }
            if (child.pid) {
              this.forceKillProcess(child);
            }
          }
        }
      );

      // Start monitoring
      if (child.pid) {
        memoryMonitor.start(child.pid);
      }
      timeoutManager.start();

      // Capture stdout
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;

        // Сбросить idle-таймаут при любой активности (модель работает)
        timeoutManager.resetIdleTimeout();

        // Detect response section start
        if (text.includes(MARKER_RESPONSE_START)) {
          inResponseSection = true;
          responseSectionStartTime = Date.now();
          // TTFT = time from test start to first real token after START marker
          result.ttftMs = responseSectionStartTime - testStartTime;
          return;
        }

        if (text.includes(MARKER_RESPONSE_END)) {
          inResponseSection = false;
          return;
        }

        // Track first real token for more accurate TTFT
        if (inResponseSection && !firstRealTokenReceived && text.trim().length > 0) {
          firstRealTokenReceived = true;
          result.ttftMs = Date.now() - testStartTime;
        }

        // Print response tokens in real-time
        if (inResponseSection) {
          process.stdout.write(text);
        }
      });

      // Capture stderr
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Process exit
      child.on('close', (code) => {
        memoryMonitor.stop();
        timeoutManager.cancel();
        this.currentProcess = null;

        result.duration = Date.now() - testStartTime;

        // Check if already failed due to timeout/OOM
        if (result.errorType) {
          this.logger.log(`\n❌ ТЕСТ ПРОВАЛЕН: ${result.error}`);
          resolve(result);
          return;
        }

        if (code === 0) {
          result.success = true;

          // Parse results
          const responseTimeMatch = stdout.match(/Response Time:\s*(\d+)ms/);
          const contextSizeMatch = stdout.match(/Context Size:\s*(\d+)/);

          if (responseTimeMatch) result.responseTimeMs = parseInt(responseTimeMatch[1], 10);
          if (contextSizeMatch) result.contextSize = parseInt(contextSizeMatch[1], 10);

          result.peakMemoryMB = memoryMonitor.stop();

          // Extract full response text for quality evaluation
          const responseText = extractResponse(stdout);
          if (responseText) {
            result.fullResponse = responseText;
            result.responseLength = responseText.length;

            // Calculate tokens more accurately
            const tokenCount = calculateTokens(responseText);
            if (result.responseTimeMs && result.responseTimeMs > 0) {
              result.tokensPerSecond = parseFloat(((tokenCount / result.responseTimeMs) * 1000).toFixed(2));
            }
          } else {
            result.responseLength = stdout.length;
          }

        } else {
          result.success = false;
          result.errorType = 'crash';
          result.error = stderr || `Процесс завершился с кодом ${code}`;
          this.logger.log(`\n❌ КРАХ: модель не загрузилась (код: ${code})`);
        }

        resolve(result);
      });

      // Error handler
      child.on('error', (error) => {
        memoryMonitor.stop();
        timeoutManager.cancel();
        this.currentProcess = null;

        result.success = false;
        result.errorType = 'crash';
        result.error = error.message;
        result.duration = Date.now() - testStartTime;

        this.logger.log(`\n❌ ОШИБКА ПРОЦЕССА: ${error.message}`);
        resolve(result);
      });
    });
  }

  /**
   * SELF-EVALUATION: после всех циклов — каждая модель анализирует результаты тестирования
   */
  private async runSelfEvaluation(models: string[], totalCycles: number, startTime: number): Promise<void> {
    if (this.isShuttingDown) return;

    let results = this.collector.getResults();
    let summary = this.collector.getSummary();

    // Если циклы пропущены (0) или результатов нет — загружаем предыдущий отчёт
    if (results.length === 0) {
      this.logger.log('\n📂 Нет результатов из циклов — загружаю предыдущий отчёт из test-results/');
      const prevReport = this.loadLastReport();
      if (prevReport) {
        results = prevReport.results;
        summary = prevReport.summary.models;
        this.logger.log(`✅ Загружен отчёт: ${results.length} тестов, ${Object.keys(summary).length} моделей`);
      } else {
        this.logger.log('⚠️  Предыдущий отчёт не найден — self-evaluation невозможна');
        this.generateReport([], Date.now() - startTime);
        return;
      }
    }

    // Формируем текстовую сводку для моделей
    const evaluationPrompt = this.buildSelfEvaluationPrompt(results, summary, totalCycles, Date.now() - startTime);

    this.logger.boldSeparator();
    this.logger.log('🧠 SELF-EVALUATION: Анализ результатов моделями');
    this.logger.boldSeparator();
    this.logger.log('Каждая модель получает сводку результатов и должна дать свою оценку');
    this.logger.log('');

    // Reset selfEvalResults
    this.selfEvalResults = [];

    const totalSelfEval = models.length;
    let completedSelfEval = 0;

    for (const modelName of models) {
      if (this.isShuttingDown) break;

      this.logger.log(`\n${'─'.repeat(80)}`);
      this.logger.log(`📝 Оценка модели: ${modelName}`);
      this.logger.log(`${'─'.repeat(80)}`);

      const evalResult = await this.runSelfEvaluationForModel(modelName, evaluationPrompt);
      this.selfEvalResults.push(evalResult);
      completedSelfEval++;

      // Update progress bar
      this.progressBar.render(completedSelfEval, totalSelfEval, `Self-eval ${modelName}`);

      this.logger.log(`\n💬 Ответ модели:`);
      this.logger.log(evalResult.response || '(нет ответа)');
      this.logger.log('');
    }

    this.progressBar.clear();

    // Финальный отчёт — теперь с self-evaluation!
    this.generateReport(results, Date.now() - startTime);
  }

  /**
   * Загружает последний отчёт из test-results/
   */
  private loadLastReport(): TestReport | null {
    try {
      const files = fs.readdirSync(this.config.outputDir)
        .filter(f => f.startsWith('report-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (files.length === 0) return null;

      const lastReportPath = path.join(this.config.outputDir, files[0]);
      const content = fs.readFileSync(lastReportPath, 'utf-8');
      return JSON.parse(content) as TestReport;
    } catch {
      return null;
    }
  }

  /**
   * Формирует промпт с результатами тестирования для self-evaluation
   */
  private buildSelfEvaluationPrompt(results: ModelTestResult[], summary: Record<string, ModelSummary>, totalCycles: number, totalDurationMs: number): string {
    const lines: string[] = [];
    const modelsPath = getAvailableModels().modelsPath;

    // Группируем результаты по моделям
    const byModel = new Map<string, ModelTestResult[]>();
    for (const r of results) {
      if (!byModel.has(r.modelName)) byModel.set(r.modelName, []);
      byModel.get(r.modelName)!.push(r);
    }

    lines.push('Ты — AI-модель, участвующая в тестировании. Проанализируй результаты и дай свою оценку качества генерации.\n');

    lines.push('## Сводка тестирования:\n');
    lines.push(`- Всего циклов: ${totalCycles}`);
    lines.push(`- Всего тестов: ${results.length}`);
    lines.push(`- Успешных: ${results.filter(r => r.success).length}`);
    lines.push(`- Проваленных: ${results.filter(r => !r.success).length}`);
    lines.push(`- Общее время: ${formatDuration(totalDurationMs)}\n`);

    lines.push('---\n');
    lines.push('## РЕЗУЛЬТАТЫ ПО МОДЕЛЯМ (с примерами ответов)\n');
    lines.push('---\n');

    for (const [modelName, modelResults] of byModel) {
      // Физический размер файла
      let fileSizeMB = '—';
      try {
        const filePath = path.join(modelsPath, modelName);
        const stat = fs.statSync(filePath);
        fileSizeMB = `${Math.floor(stat.size / (1024 * 1024))}MB`;
      } catch {}

      const stats = summary[modelName];

      lines.push(`\n### 📦 ${modelName}`);
      lines.push(`- Размер файла: ${fileSizeMB}`);
      lines.push(`- Успешно: ${stats.successful}/${stats.totalTests}`);
      lines.push(`- Ср. токенов/сек: ${stats.avgTokensPerSecond}`);
      lines.push(`- Ср. время ответа: ${stats.avgResponseTimeMs}ms`);
      lines.push(`- Пик памяти (RSS): ${stats.avgPeakMemoryMB}MB`);
      lines.push(`- Ср. TTFT: ${stats.avgTtftMs}ms`);

      // Показываем примеры ответов (первые 2-3 успешных)
      const successfulResults = modelResults.filter(r => r.success && r.fullResponse);
      if (successfulResults.length > 0) {
        lines.push('\n#### Примеры ответов этой модели:\n');

        for (let i = 0; i < Math.min(MAX_EXAMPLE_RESPONSES, successfulResults.length); i++) {
          const r = successfulResults[i];
          const responsePreview = r.fullResponse!.length > MAX_RESPONSE_PREVIEW
            ? r.fullResponse!.substring(0, MAX_RESPONSE_PREVIEW) + '... [обрезано]'
            : r.fullResponse!;

          lines.push(`**Тест ${r.cycle}:** "${r.question}"`);
          lines.push(`**Длина ответа:** ${r.responseLength} символов`);
          lines.push(`**Ответ модели:**`);
          lines.push('```');
          lines.push(responsePreview);
          lines.push('```\n');
        }
      }

      lines.push('');
    }

    lines.push('---\n');
    lines.push('## Твои задачи:\n');
    lines.push('ВАЖНО: Ответь в СТРУКТУРИРОВАННОМ формате. Для каждой категории укажи оценки в формате:\n');
    lines.push('`- имя_модели_точно: оценка/10 — краткий комментарий`');
    lines.push('');
    lines.push('#### Корректность кода');
    lines.push('');
    lines.push('#### Обработка ошибок');
    lines.push('');
    lines.push('#### Типизация TypeScript');
    lines.push('');
    lines.push('#### Архитектурные решения');
    lines.push('');
    lines.push('#### Развёрнутость объяснений');
    lines.push('');
    lines.push('#### Законченность ответов');
    lines.push('');
    lines.push('### Лучшая модель');
    lines.push('Назови одну лучшую модель для AI-проектов на Node.js и объясни почему.');
    lines.push('');
    lines.push('### Предложения по улучшению');
    lines.push('');
    lines.push('---\n');
    lines.push('Будь объективной — не ставь себя на первое место автоматически. Оценивай по фактам.');

    return lines.join('\n');
  }

  /**
   * Запускает модель для self-evaluation
   */
  private async runSelfEvaluationForModel(modelName: string, evaluationPrompt: string): Promise<SelfEvalResult> {
    const result: SelfEvalResult = {
      modelName,
      response: '',
      success: false,
      duration: 0,
      ratings: [],
      bestModelPick: '',
      improvements: []
    };

    const startTime = Date.now();

    return new Promise((resolve) => {
      // Spawn child process with EVAL_QUESTION env
      const child = spawn('node', [
        '-r', 'tsconfig-paths/register',
        'dist/index.js',
        modelName
      ], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, EVAL_QUESTION: evaluationPrompt }
      });

      this.currentProcess = child;
      let stdout = '';

      // Capture stdout
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;

        if (text.includes(MARKER_RESPONSE_START)) return;
        if (text.includes(MARKER_RESPONSE_END)) return;

        // Print in real-time
        process.stdout.write(text);
      });

      child.on('close', (code) => {
        this.currentProcess = null;
        result.duration = Date.now() - startTime;

        if (code === 0) {
          result.success = true;
          // Extract response using helper
          const responseText = extractResponse(stdout);
          result.response = responseText || '(Ответ получен, но не удалось извлечь)';

          // Parse structured ratings
          const allModelNames = getAvailableModels().models;
          const parsed = parseSelfEvalRatings(modelName, result.response, allModelNames);
          result.ratings = parsed.ratings;
          result.bestModelPick = parsed.bestModelPick;
          result.improvements = parsed.improvements;
        } else {
          result.response = `Ошибка: процесс завершился с кодом ${code}`;
        }

        resolve(result);
      });

      child.on('error', (error) => {
        this.currentProcess = null;
        result.duration = Date.now() - startTime;
        result.response = `Ошибка процесса: ${error.message}`;
        resolve(result);
      });
    });
  }

  private printResultSummary(result: ModelTestResult): void {
    this.logger.log(`\n${'═'.repeat(80)}`);
    this.logger.log(`📊 РЕЗУЛЬТАТ`);
    this.logger.log(`${'═'.repeat(80)}`);
    this.logger.log(`Модель:        ${result.modelName}`);
    this.logger.log(`Цикл:          ${result.cycle}/${this.config.cycles}`);
    this.logger.log(`Статус:        ${result.success ? '✅ Успешно' : '❌ Провалено'}`);
    this.logger.log(`Время теста:   ${formatDuration(result.duration)}`);

    if (result.success) {
      if (result.ttftMs) {
        this.logger.log(`⏱️  TTFT:              ${result.ttftMs}ms`);
      }
      if (result.responseTimeMs) {
        this.logger.log(`⏱️  Время ответа:    ${result.responseTimeMs}ms`);
      }
      if (result.tokensPerSecond) {
        this.logger.log(`🔢 Токенов/сек:     ${result.tokensPerSecond}`);
      }
      if (result.peakMemoryMB) {
        this.logger.log(`💾 Пик памяти:       ${result.peakMemoryMB}MB`);
      }
      if (result.contextSize) {
        this.logger.log(`📏 Размер контекста: ${result.contextSize}`);
      }
    } else if (result.error) {
      const errorLabel = result.errorType === 'idle' ? '⏸️  Нет активности'
        : result.errorType === 'timeout' ? '⏱️  Таймаут'
          : result.errorType === 'oom' ? '💾 OOM'
            : '❌';
      this.logger.log(`${errorLabel}: ${result.error}`);
    }

    this.logger.log(`${'═'.repeat(80)}`);
  }

  private generateReport(results: ModelTestResult[], totalDurationMs: number): void {
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const modelSummaries = this.collector.getSummary();

    const report: TestReport = {
      summary: {
        totalTests: results.length,
        successful,
        failed,
        totalDurationMs,
        totalDurationHuman: formatDuration(totalDurationMs),
        models: modelSummaries
      },
      results,
      selfEvaluation: this.selfEvalResults,
      config: this.config,
      timestamp: new Date().toISOString()
    };

    const paths = this.reportGenerator.save(report);

    this.logger.boldSeparator();
    this.logger.log('🏁 ИТОГОВЫЙ ОТЧЁТ');
    this.logger.boldSeparator();
    this.logger.log(`Всего тестов:      ${results.length}`);
    this.logger.log(`✅ Успешно:         ${successful}`);
    this.logger.log(`❌ Провалено:       ${failed}`);
    this.logger.log(`⏱️  Общее время:    ${formatDuration(totalDurationMs)}`);
    this.logger.log(`📝 Markdown: ${paths.markdown}`);
    this.logger.log(`📝 JSON:       ${paths.json}`);
    this.logger.boldSeparator();

    // Print model table
    this.logger.log('\nМодель'.padEnd(45) + 'Успешно'.padEnd(12) + 'Провалено'.padEnd(12) + 'Ток/с'.padEnd(10) + 'Пик Mem');
    this.logger.log('─'.repeat(90));

    for (const [modelName, stats] of Object.entries(modelSummaries)) {
      const shortName = modelName.length > 43 ? modelName.substring(0, 40) + '...' : modelName;
      this.logger.log(
        shortName.padEnd(45) +
        stats.successful.toString().padEnd(12) +
        stats.failed.toString().padEnd(12) +
        stats.avgTokensPerSecond.toString().padEnd(10) +
        `${stats.avgPeakMemoryMB}MB`
      );
    }

    this.logger.log('');
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  // Get questions from QuestionService
  const questionService = new QuestionService();
  const allQuestions = questionService.getAllQuestions();

  const config = { ...DEFAULT_CONFIG };
  config.testQuestions = allQuestions;

  // Calculate memory limit dynamically
  config.memoryLimitMB = calculateMemoryLimitMB(config.supervisorMemoryReserveMB);

  // Create output directory
  fs.mkdirSync(config.outputDir, { recursive: true });

  const orchestrator = new TestOrchestrator(config);
  await orchestrator.run();
}

// Run the test
main().catch((error) => {
  console.error('💥 Неожиданная ошибка:', error);
  process.exit(1);
});
