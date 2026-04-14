import 'dotenv/config';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import * as readline from 'readline';
import { createInterface } from 'readline';

// ============================================================================
// TYPES
// ============================================================================

interface FileSystemEvent {
  timestamp: string;
  operation: 'change' | 'rename' | 'error';
  filePath: string;
  details?: string;
}

interface NetworkEvent {
  timestamp: string;
  type: 'connect' | 'disconnect' | 'data_sent' | 'data_received';
  remoteAddress?: string;
  port?: number;
  bytes?: number;
  protocol?: string;
}

interface TerminalEvent {
  timestamp: string;
  type: 'output' | 'input' | 'resize' | 'clear';
  content: string;
  source: 'stdout' | 'stderr' | 'stdin';
}

interface KeyboardEvent {
  timestamp: string;
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  action: 'press' | 'release' | 'combination';
}

interface MemorySnapshot {
  timestamp: string;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  childPid?: number;
  childRssMB?: number;
}

interface SessionConfig {
  command: string;
  args: string[];
  outputDir: string;
  monitorPaths: string[];
}

interface SessionReport {
  command: string;
  startTime: string;
  endTime: string;
  duration: string;
  durationMs: number;
  exitCode: number | null;
  terminalEvents: number;
  fileSystemEvents: FileSystemEvent[];
  networkEvents: NetworkEvent[];
  keyboardEvents: KeyboardEvent[];
  memorySnapshots: number;
  peakMemoryMB: number;
  childPeakMemoryMB: number;
  errors: string[];
  terminalOutput: string;
  terminalInput: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const ESC_KEY_CODE = 27;
const CTRL_C_CODE = 3;
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), 'test-results');

// ============================================================================
// UTILITIES
// ============================================================================

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function getProcessMemoryMB(pid: number): number {
  try {
    const output = execSync(`ps -o rss= -p ${pid}`).toString().trim();
    return Math.floor(parseInt(output, 10) / 1024);
  } catch {
    return 0;
  }
}

function getAvailableMemoryMB(): number {
  try {
    if (os.platform() === 'linux') {
      const meminfo = execSync('cat /proc/meminfo').toString();
      const memAvailableMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
      if (memAvailableMatch) {
        return Math.floor(parseInt(memAvailableMatch[1], 10) / 1024);
      }
    }
  } catch {}
  return Math.floor(os.totalmem() / (1024 * 1024));
}

function tryFreeMemory(logger: (msg: string) => void): void {
  const attempts: string[] = [];

  try {
    execSync('sync', { timeout: 5000 });
    attempts.push('✅ sync: буферы сброшены');
  } catch {
    attempts.push('❌ sync: ошибка');
  }

  try {
    execSync('sudo sh -c "echo 3 > /proc/sys/vm/drop_caches"', {
      stdio: 'pipe',
      timeout: 30000
    });
    attempts.push('✅ drop_caches: кэш очищен');
  } catch {
    attempts.push('⚠️  drop_caches: недоступно');
  }

  try {
    execSync('sudo sysctl -w vm.swappiness=100', {
      stdio: 'pipe',
      timeout: 30000
    });
    attempts.push('✅ swappiness: 100');
  } catch {
    attempts.push('⚠️  swappiness: недоступно');
  }

  attempts.forEach(a => logger(`   ${a}`));

  const availableAfter = getAvailableMemoryMB();
  logger(`   📊 Доступно памяти: ${availableAfter}MB`);
}

// ============================================================================
// FILE SYSTEM MONITOR
// ============================================================================

class FileSystemMonitor {
  private events: FileSystemEvent[] = [];
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private watchingPaths: Set<string> = new Set();

  start(watchPaths: string[]): void {
    for (const watchPath of watchPaths) {
      if (this.watchingPaths.has(watchPath)) continue;

      try {
        const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
          if (filename) {
            const event: FileSystemEvent = {
              timestamp: timestamp(),
              operation: eventType,
              filePath: path.join(watchPath, filename),
              details: `Event: ${eventType}`
            };

            this.events.push(event);
          }
        });

        this.watchers.set(watchPath, watcher);
        this.watchingPaths.add(watchPath);

        this.events.push({
          timestamp: timestamp(),
          operation: 'rename',
          filePath: watchPath,
          details: 'Начало наблюдения'
        });
      } catch (error) {
        this.events.push({
          timestamp: timestamp(),
          operation: 'error',
          filePath: watchPath,
          details: `Ошибка настройки: ${error}`
        });
      }
    }
  }

  getEvents(): FileSystemEvent[] {
    return this.events;
  }

  stop(): void {
    for (const [watchPath, watcher] of this.watchers) {
      try {
        watcher.close();
        this.events.push({
          timestamp: timestamp(),
          operation: 'rename',
          filePath: watchPath,
          details: 'Наблюдение остановлено'
        });
      } catch {}
    }
    this.watchers.clear();
    this.watchingPaths.clear();
  }
}

// ============================================================================
// NETWORK MONITOR
// ============================================================================

class NetworkMonitor {
  private events: NetworkEvent[] = [];
  private connections: Map<string, number> = new Map();

  scanProcessConnections(pid: number): void {
    try {
      if (os.platform() === 'linux') {
        const tcpInfo = execSync(`cat /proc/net/tcp 2>/dev/null || true`).toString();
        const lines = tcpInfo.split('\n').slice(1);

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 10) continue;

          const [localAddrHex, remoteAddrHex, stateHex] = parts;
          const state = parseInt(stateHex, 16);

          // 01 = ESTABLISHED
          if (state === 0x01) {
            const [localIpHex, localPortHex] = localAddrHex.split(':');
            const [remoteIpHex, remotePortHex] = remoteAddrHex.split(':');

            const remotePort = parseInt(remotePortHex, 16);

            if (remotePort !== 0) {
              const remoteIp = this.hexToIP(remoteIpHex);
              const key = `${remoteIp}:${remotePort}`;

              if (!this.connections.has(key)) {
                this.connections.set(key, Date.now());
                this.events.push({
                  timestamp: timestamp(),
                  type: 'connect',
                  remoteAddress: remoteIp,
                  port: remotePort
                });
              }
            }
          }
        }
      }
    } catch {}
  }

  private hexToIP(hex: string): string {
    const bytes = hex.match(/.{2}/g)?.map(b => parseInt(b, 16)) || [];
    if (bytes.length === 4) {
      return bytes.reverse().join('.');
    }
    return hex;
  }

  getEvents(): NetworkEvent[] {
    return this.events;
  }

  getActiveConnections(): number {
    return this.connections.size;
  }
}

// ============================================================================
// TERMINAL MONITOR
// ============================================================================

class TerminalMonitor {
  private outputBuffer: string = '';
  private inputBuffer: string = '';

  logOutput(content: string, source: 'stdout' | 'stderr'): void {
    this.outputBuffer += content;
  }

  logInput(content: string): void {
    this.inputBuffer += content;
  }

  getOutput(): string {
    return this.outputBuffer;
  }

  getInput(): string {
    return this.inputBuffer;
  }

  clear(): void {
    this.outputBuffer = '';
    this.inputBuffer = '';
  }
}

// ============================================================================
// KEYBOARD MONITOR
// ============================================================================

class KeyboardMonitor {
  private events: KeyboardEvent[] = [];
  private onDataHandler: ((data: Buffer) => void) | null = null;

  start(onEsc: () => void): void {
    process.stdin.setRawMode(true);

    this.onDataHandler = (data: Buffer) => {
      const keyCode = data[0];
      const key = data.toString();

      if (keyCode === CTRL_C_CODE) {
        this.logKeyEvent('Ctrl+C', true, false, false, 'combination');
        process.exit(130);
        return;
      }

      if (keyCode === ESC_KEY_CODE) {
        this.logKeyEvent('Esc', false, false, false, 'press');
        onEsc();
        return;
      }

      // Перенаправляем ввод в дочерний процесс
      let keyName = key;
      if (key === '\n' || key === '\r') keyName = 'Enter';
      else if (key === '\t') keyName = 'Tab';
      else if (key === ' ') keyName = 'Space';
      else if (key === '\x7f') keyName = 'Backspace';

      this.logKeyEvent(keyName, false, false, false, 'press');
    };

    process.stdin.on('data', this.onDataHandler);
  }

  private logKeyEvent(key: string, ctrl: boolean, shift: boolean, alt: boolean, action: KeyboardEvent['action']): void {
    this.events.push({
      timestamp: timestamp(),
      key,
      ctrl,
      shift,
      alt,
      action
    });
  }

  getEvents(): KeyboardEvent[] {
    return this.events;
  }

  stop(): void {
    if (this.onDataHandler) {
      process.stdin.removeListener('data', this.onDataHandler);
    }
    if (process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  }
}

// ============================================================================
// MEMORY TRACKER
// ============================================================================

class MemoryTracker {
  private snapshots: MemorySnapshot[] = [];
  private peakMemoryMB: number = 0;
  private childPeakMemoryMB: number = 0;
  private monitorInterval: NodeJS.Timeout | null = null;
  private childPid: number | null = null;

  start(pid?: number, intervalMs: number = 2000): void {
    if (pid) this.childPid = pid;

    this.monitorInterval = setInterval(() => {
      const nodeMemory = process.memoryUsage();
      const snapshot: MemorySnapshot = {
        timestamp: timestamp(),
        rss: nodeMemory.rss,
        heapTotal: nodeMemory.heapTotal,
        heapUsed: nodeMemory.heapUsed,
        external: nodeMemory.external,
        arrayBuffers: nodeMemory.arrayBuffers || 0
      };

      // Track child process memory
      if (this.childPid) {
        const childMemMB = getProcessMemoryMB(this.childPid);
        snapshot.childPid = this.childPid;
        snapshot.childRssMB = childMemMB;

        if (childMemMB > this.childPeakMemoryMB) {
          this.childPeakMemoryMB = childMemMB;
        }
      }

      this.snapshots.push(snapshot);

      const totalMB = snapshot.rss / (1024 * 1024);
      if (totalMB > this.peakMemoryMB) {
        this.peakMemoryMB = totalMB;
      }
    }, intervalMs);
  }

  getPeakMemoryMB(): number {
    return this.peakMemoryMB;
  }

  getChildPeakMemoryMB(): number {
    return this.childPeakMemoryMB;
  }

  getSnapshots(): MemorySnapshot[] {
    return this.snapshots;
  }

  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }
}

// ============================================================================
// SESSION LOGGER
// ============================================================================

class SessionLogger {
  private logDir: string;
  private mainLog: string;
  private fsLog: string;
  private netLog: string;
  private kbLog: string;
  private memLog: string;
  private terminalLog: string;

  constructor(outputDir: string) {
    const sessionTime = new Date().toISOString().replace(/[:.]/g, '-');
    this.logDir = path.join(outputDir, `session-${sessionTime}`);
    fs.mkdirSync(this.logDir, { recursive: true });

    this.mainLog = path.join(this.logDir, 'main.log');
    this.fsLog = path.join(this.logDir, 'filesystem.log');
    this.netLog = path.join(this.logDir, 'network.log');
    this.kbLog = path.join(this.logDir, 'keyboard.log');
    this.memLog = path.join(this.logDir, 'memory.log');
    this.terminalLog = path.join(this.logDir, 'terminal.log');

    [this.mainLog, this.fsLog, this.netLog, this.kbLog, this.memLog, this.terminalLog].forEach(logPath => {
      fs.writeFileSync(logPath, '');
    });
  }

  getLogDir(): string {
    return this.logDir;
  }

  log(message: string, toConsole: boolean = true): void {
    const logMessage = `[${timestamp()}] ${message}\n`;
    fs.appendFileSync(this.mainLog, logMessage);
    if (toConsole) {
      console.log(message);
    }
  }

  logFS(event: FileSystemEvent): void {
    const logMessage = `[${event.timestamp}] ${event.operation.toUpperCase()} ${event.filePath}${event.details ? ` (${event.details})` : ''}\n`;
    fs.appendFileSync(this.fsLog, logMessage);
  }

  logNetwork(event: NetworkEvent): void {
    const logMessage = `[${event.timestamp}] ${event.type.toUpperCase()} ${event.remoteAddress || ''}${event.port ? `:${event.port}` : ''}${event.bytes ? ` (${event.bytes} bytes)` : ''}\n`;
    fs.appendFileSync(this.netLog, logMessage);
  }

  logKeyboard(event: KeyboardEvent): void {
    const logMessage = `[${event.timestamp}] KEY: ${event.key}${event.ctrl ? ' [CTRL]' : ''}${event.shift ? ' [SHIFT]' : ''}${event.alt ? ' [ALT]' : ''} (${event.action})\n`;
    fs.appendFileSync(this.kbLog, logMessage);
  }

  logMemory(snapshot: MemorySnapshot): void {
    const rssMB = (snapshot.rss / 1024 / 1024).toFixed(2);
    const heapMB = `${(snapshot.heapUsed / 1024 / 1024).toFixed(2)}/${(snapshot.heapTotal / 1024 / 1024).toFixed(2)}`;
    const childMB = snapshot.childRssMB ? ` Child: ${snapshot.childRssMB}MB` : '';
    const logMessage = `[${snapshot.timestamp}] Supervisor RSS: ${rssMB}MB | Heap: ${heapMB}MB | External: ${(snapshot.external / 1024 / 1024).toFixed(2)}MB${childMB}\n`;
    fs.appendFileSync(this.memLog, logMessage);
  }

  logTerminal(content: string, source: 'stdout' | 'stderr'): void {
    const prefix = source === 'stderr' ? '[ERR] ' : '[OUT] ';
    fs.appendFileSync(this.terminalLog, `[${timestamp()}] ${prefix}${content}`);
  }

  separator(char: string = '─', length: number = 80): void {
    this.log(char.repeat(length));
  }

  boldSeparator(char: string = '█', length: number = 80): void {
    this.log(char.repeat(length));
  }
}

// ============================================================================
// REPORT GENERATOR
// ============================================================================

class SessionReportGenerator {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  generateMarkdown(report: SessionReport): string {
    const lines: string[] = [];

    lines.push('# 🖥️ Terminal Session Report\n');
    lines.push(`**Date:** ${new Date(report.startTime).toLocaleString()}\n`);
    lines.push(`**Command:** \`${report.command}\`\n`);
    lines.push(`**Duration:** ${report.duration} (${report.durationMs}ms)\n`);
    lines.push(`**Exit Code:** ${report.exitCode ?? 'N/A'}\n`);

    // Summary
    lines.push('## 📊 Summary\n');
    lines.push(`- **Supervisor Peak Memory:** ${report.peakMemoryMB}MB`);
    lines.push(`- **Child Process Peak Memory:** ${report.childPeakMemoryMB}MB`);
    lines.push(`- **Terminal Events:** ${report.terminalEvents}`);
    lines.push(`- **File System Events:** ${report.fileSystemEvents.length}`);
    lines.push(`- **Network Events:** ${report.networkEvents.length}`);
    lines.push(`- **Keyboard Events:** ${report.keyboardEvents.length}`);
    lines.push(`- **Memory Snapshots:** ${report.memorySnapshots}`);
    lines.push(`- **Errors:** ${report.errors.length}\n`);

    // File System Activity
    if (report.fileSystemEvents.length > 0) {
      lines.push('## 📁 File System Activity\n');
      lines.push('| Time | Operation | Path | Details |');
      lines.push('|------|-----------|------|---------|');

      const maxEvents = 100;
      for (const event of report.fileSystemEvents.slice(0, maxEvents)) {
        const shortPath = event.filePath.length > 50 ? event.filePath.substring(0, 47) + '...' : event.filePath;
        const shortDetails = event.details ? (event.details.length > 40 ? event.details.substring(0, 37) + '...' : event.details) : '';
        lines.push(`| ${new Date(event.timestamp).toLocaleTimeString()} | ${event.operation} | ${shortPath} | ${shortDetails} |`);
      }

      if (report.fileSystemEvents.length > maxEvents) {
        lines.push(`\n*... и ещё ${report.fileSystemEvents.length - maxEvents} событий*\n`);
      }
    }

    // Network Activity
    if (report.networkEvents.length > 0) {
      lines.push('\n## 🌐 Network Activity\n');
      lines.push('| Time | Type | Address | Port |');
      lines.push('|------|------|---------|------|');

      for (const event of report.networkEvents) {
        const addr = event.remoteAddress || '';
        const port = event.port ? event.port.toString() : '';
        lines.push(`| ${new Date(event.timestamp).toLocaleTimeString()} | ${event.type} | ${addr} | ${port} |`);
      }
    }

    // Keyboard Events
    if (report.keyboardEvents.length > 0) {
      lines.push('\n## ⌨️ Keyboard Events\n');
      lines.push('| Time | Key | Modifiers | Action |');
      lines.push('|------|-----|-----------|--------|');

      const maxKB = 50;
      for (const event of report.keyboardEvents.slice(0, maxKB)) {
        const modifiers = [event.ctrl ? 'CTRL' : '', event.shift ? 'SHIFT' : '', event.alt ? 'ALT' : ''].filter(Boolean).join('+');
        lines.push(`| ${new Date(event.timestamp).toLocaleTimeString()} | ${event.key} | ${modifiers || '-'} | ${event.action} |`);
      }

      if (report.keyboardEvents.length > maxKB) {
        lines.push(`\n*... и ещё ${report.keyboardEvents.length - maxKB} событий*\n`);
      }
    }

    // Terminal Output
    if (report.terminalOutput) {
      lines.push('\n## 📺 Terminal Output\n');
      const maxOutput = 10000;
      if (report.terminalOutput.length > maxOutput) {
        lines.push(`*(Показаны первые ${maxOutput} символов из ${report.terminalOutput.length})*\n`);
        lines.push('```');
        lines.push(report.terminalOutput.substring(0, maxOutput));
        lines.push('```\n');
      } else {
        lines.push('```');
        lines.push(report.terminalOutput);
        lines.push('```\n');
      }
    }

    // Errors
    if (report.errors.length > 0) {
      lines.push('\n## ❌ Errors\n');
      for (const error of report.errors) {
        lines.push(`- ${error}`);
      }
    }

    return lines.join('\n');
  }

  generateJson(report: SessionReport): string {
    return JSON.stringify(report, null, 2);
  }

  save(report: SessionReport): { markdown: string; json: string } {
    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');

    const mdContent = this.generateMarkdown(report);
    const jsonContent = this.generateJson(report);

    const mdPath = path.join(this.outputDir, `session-report-${timestampStr}.md`);
    const jsonPath = path.join(this.outputDir, `session-report-${timestampStr}.json`);

    fs.writeFileSync(mdPath, mdContent);
    fs.writeFileSync(jsonPath, jsonContent);

    return { markdown: mdPath, json: jsonPath };
  }
}

// ============================================================================
// SESSION ORCHESTRATOR
// ============================================================================

class SessionOrchestrator {
  private config: SessionConfig;
  private logger: SessionLogger;
  private fsMonitor: FileSystemMonitor;
  private netMonitor: NetworkMonitor;
  private kbMonitor: KeyboardMonitor;
  private memTracker: MemoryTracker;
  private terminalMonitor: TerminalMonitor;
  private reportGenerator: SessionReportGenerator;
  private sessionStartTime: number;
  private isShuttingDown: boolean = false;
  private currentProcess: ChildProcess | null = null;
  private errors: string[] = [];
  private terminalOutput = '';

  constructor(config: SessionConfig) {
    this.config = config;
    this.logger = new SessionLogger(config.outputDir);
    this.fsMonitor = new FileSystemMonitor();
    this.netMonitor = new NetworkMonitor();
    this.kbMonitor = new KeyboardMonitor();
    this.memTracker = new MemoryTracker();
    this.terminalMonitor = new TerminalMonitor();
    this.reportGenerator = new SessionReportGenerator(config.outputDir);
    this.sessionStartTime = Date.now();
  }

  private exitCode: number | null = null;

  async run(): Promise<void> {
    const commandStr = `${this.config.command} ${this.config.args.join(' ')}`.trim();

    this.logger.boldSeparator();
    this.logger.log('🖥️  TERMINAL SESSION MONITOR', true);
    this.logger.boldSeparator();
    this.logger.log(`📋 Команда: ${commandStr}`, true);
    this.logger.log(`📂 Вывод: ${this.config.outputDir}`, true);
    this.logger.log('⎋ Press ESC to stop and generate report', true);
    this.logger.log('📊 Мониторинг: память, ФС, сеть, терминал, клавиатура', true);
    this.logger.boldSeparator();

    // Освобождаем память перед запуском
    this.logger.log('\n💾 Освобождение памяти...', true);
    tryFreeMemory((msg: string) => this.logger.log(msg, true));

    // Запуск мониторинга памяти
    this.memTracker.start();

    // Запуск мониторинга ФС
    if (this.config.monitorPaths.length > 0) {
      this.fsMonitor.start(this.config.monitorPaths);
      this.logger.log(`\n📁 Мониторинг ФС:`, true);
      for (const p of this.config.monitorPaths) {
        this.logger.log(`   - ${p}`, true);
      }
    }

    // Запуск дочернего процесса
    this.logger.log(`\n🚀 Запуск команды: ${commandStr}`, true);
    this.logger.log(`${'─'.repeat(80)}`, true);

    await this.runProcess(commandStr);

    // Генерация отчёта
    if (!this.isShuttingDown) {
      this.generateReport();
    }
  }

  private async runProcess(commandStr: string): Promise<void> {
    const [cmd, ...args] = commandStr.split(' ');

    return new Promise<void>((resolve) => {
      const child = spawn(cmd!, args, {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      this.currentProcess = child;

      // Старт мониторинга памяти процесса
      if (child.pid) {
        this.memTracker.start(child.pid);

        // Сканирование сетевых соединений через 3 секунды
        setTimeout(() => {
          this.netMonitor.scanProcessConnections(child.pid!);
        }, 3000);
      }

      // Перенаправление stdout
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.terminalOutput += text;
        this.terminalMonitor.logOutput(text, 'stdout');
        this.logger.logTerminal(text, 'stdout');

        // Выводим в родительский терминал
        process.stdout.write(text);
      });

      // Перенаправление stderr
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.terminalOutput += text;
        this.terminalMonitor.logOutput(text, 'stderr');
        this.logger.logTerminal(text, 'stderr');

        // Выводим в родительский терминал
        process.stderr.write(text);
      });

      // Запуск мониторинга клавиатуры
      this.kbMonitor.start(() => {
        if (!this.isShuttingDown) {
          this.shutdown('ESC');
        }
      });

      // Перенаправление клавиатурного ввода в дочерний процесс
      process.stdin.on('data', (data: Buffer) => {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write(data);
        }
        this.terminalMonitor.logInput(data.toString());
      });

      // Завершение процесса
      child.on('close', (code) => {
        this.exitCode = code;
        this.currentProcess = null;

        this.memTracker.stop();
        this.kbMonitor.stop();
        this.fsMonitor.stop();

        this.logger.log('', true);
        this.logger.log(`${'─'.repeat(80)}`, true);
        this.logger.log(`✅ Процесс завершён с кодом: ${code}`, true);

        this.generateReport();
        resolve();
      });

      child.on('error', (error) => {
        this.currentProcess = null;
        this.errors.push(`Ошибка запуска: ${error.message}`);

        this.memTracker.stop();
        this.kbMonitor.stop();
        this.fsMonitor.stop();

        this.logger.log(`❌ Ошибка процесса: ${error.message}`, true);
        this.generateReport();
        resolve();
      });
    });
  }

  private shutdown(reason: string): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.log(`\n🛑 Прерывание по: ${reason}`, true);

    if (this.currentProcess) {
      this.logger.log('⚠️  Завершение процесса...', true);
      try {
        this.currentProcess.kill('SIGTERM');

        // Если не завершился через 5 секунд - SIGKILL
        setTimeout(() => {
          if (this.currentProcess && !this.currentProcess.killed) {
            this.currentProcess.kill('SIGKILL');
          }
        }, 5000);
      } catch {}
    }

    this.memTracker.stop();
    this.kbMonitor.stop();
    this.fsMonitor.stop();
  }

  private generateReport(): void {
    const endTime = Date.now();
    const durationMs = endTime - this.sessionStartTime;
    const commandStr = `${this.config.command} ${this.config.args.join(' ')}`.trim();

    const report: SessionReport = {
      command: commandStr,
      startTime: new Date(this.sessionStartTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      duration: formatDuration(durationMs),
      durationMs,
      exitCode: this.exitCode,
      terminalEvents: this.terminalMonitor.getOutput().length + this.terminalMonitor.getInput().length,
      fileSystemEvents: this.fsMonitor.getEvents(),
      networkEvents: this.netMonitor.getEvents(),
      keyboardEvents: this.kbMonitor.getEvents(),
      memorySnapshots: this.memTracker.getSnapshots().length,
      peakMemoryMB: this.memTracker.getPeakMemoryMB(),
      childPeakMemoryMB: this.memTracker.getChildPeakMemoryMB(),
      errors: this.errors,
      terminalOutput: this.terminalMonitor.getOutput(),
      terminalInput: this.terminalMonitor.getInput()
    };

    const paths = this.reportGenerator.save(report);

    this.logger.boldSeparator();
    this.logger.log('🏁 ОТЧЁТ СЕССИИ', true);
    this.logger.boldSeparator();
    this.logger.log(`Команда:        ${commandStr}`, true);
    this.logger.log(`Длительность:   ${report.duration}`, true);
    this.logger.log(`Память (супервайзер): ${report.peakMemoryMB}MB`, true);
    this.logger.log(`Память (процесс):     ${report.childPeakMemoryMB}MB`, true);
    this.logger.log(`События ФС:   ${report.fileSystemEvents.length}`, true);
    this.logger.log(`Сетевые события: ${report.networkEvents.length}`, true);
    this.logger.log(`События клавиатуры: ${report.keyboardEvents.length}`, true);
    this.logger.log(`Ошибки:         ${report.errors.length}`, true);
    this.logger.log('', true);
    this.logger.log(`📝 Markdown: ${paths.markdown}`, true);
    this.logger.log(`📝 JSON:       ${paths.json}`, true);
    this.logger.log(`📁 Папка логов: ${this.logger.getLogDir()}`, true);
    this.logger.boldSeparator();
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npm run test:sv -- <command> [args...]');
    console.log('');
    console.log('Examples:');
    console.log('  npm run test:sv -- ollama run qwen2.5:1.5b');
    console.log('  npm run test:sv -- python script.py');
    console.log('  npm run test:sv -- node my-app.js');
    console.log('');
    console.log('Press ESC to stop monitoring and generate report');
    process.exit(1);
  }

  const [command, ...restArgs] = args;

  const config: SessionConfig = {
    command: command!,
    args: restArgs,
    outputDir: DEFAULT_OUTPUT_DIR,
    monitorPaths: [
      process.cwd(),
      path.join(process.cwd(), 'test-results')
    ]
  };

  const orchestrator = new SessionOrchestrator(config);
  await orchestrator.run();
}

main().catch((error) => {
  console.error('💥 Unexpected error:', error);
  process.exit(1);
});
