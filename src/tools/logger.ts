/**
 * Утилита для логирования использования инструментов
 */

/**
 * Логирование вызова инструмента
 */
export function logToolCall(name: string, params: Record<string, unknown>): void {
  console.log(`\n🔧 [TOOL CALL] ${name}`);
  console.log(`   Параметры: ${JSON.stringify(params, null, 2)}`);
}

/**
 * Логирование результата инструмента
 */
export function logToolResult(name: string, result: unknown): void {
  console.log(`🔧 [TOOL RESULT] ${name}`);
  console.log(`   Результат: ${JSON.stringify(result, null, 2)}\n`);
}

/**
 * Логирование ошибки инструмента
 */
export function logToolError(name: string, error: unknown): void {
  console.log(`🔧 [TOOL ERROR] ${name}`);
  console.log(`   Ошибка: ${error}\n`);
}
