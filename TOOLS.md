# Инструменты локальной модели (Tools/Functions)

## Обзор

В проекте реализована поддержка инструментов (function calling) для локальных LLM моделей через `node-llama-cpp`. Это позволяет модели вызывать predefined функции для получения конкретной информации.

## Доступные инструменты

### 1. `getWeather` - Получение погоды
**Описание:** Получение текущей температуры в городе

**Параметры:**
- `city` (string, обязательный) - название города (например: "Moscow", "London", "Tokyo")

**Возвращает:**
```json
{
  "city": "Moscow",
  "temperature": "15°C",
  "status": "found"
}
```

**Доступные города:** Moscow (15°C), London (12°C), Paris (18°C), Tokyo (25°C), New York (20°C)

### 2. `calculator` - Калькулятор
**Описание:** Выполнение математических вычислений

**Параметры:**
- `expression` (string, обязательный) - математическое выражение (например: "2 + 2", "10 * 5")

**Возвращает:**
```json
{
  "expression": "245 * 37",
  "result": "9065",
  "status": "success"
}
```

**Поддерживаемые операторы:** `+`, `-`, `*`, `/`, скобки `()`, десятичные числа

### 3. `searchKnowledge` - Поиск знаний
**Описание:** Поиск информации в базе знаний

**Параметры:**
- `query` (string, обязательный) - поисковый запрос

**Возвращает:**
```json
{
  "query": "capital of france",
  "result": "Paris",
  "status": "found"
}
```

**База знаний содержит:**
- capital of russia → Moscow
- capital of france → Paris  
- capital of japan → Tokyo

## Как это работает

### 1. Определение инструментов
Все инструменты определены в `src/tools/index.ts` с помощью `defineChatSessionFunction()`:

```typescript
export const getWeather = defineChatSessionFunction({
  description: 'Get the current temperature in a city',
  params: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' }
    },
    required: ['city']
  },
  async handler(params) {
    // реализация
  }
});
```

### 2. Передача в модель
Инструменты передаются в метод `session.prompt()` при каждом запросе:

```typescript
const response = await this.session.prompt(prompt, {
  temperature: 0.7,
  functions: availableFunctions  // <-- передаём все инструменты
});
```

### 3. Логирование
При загрузке модели автоматически логируются доступные инструменты:

```
=== Проверка инструментов локальной модели ===
📦 Зарегистрировано инструментов: 3
📋 Список: getWeather, calculator, searchKnowledge
✅ Найдены функции в session.functions: 3
  🔧 getWeather:
     Описание: Get the current temperature in a city
     Параметры: {"city":{"type":"string","description":"City name..."}}
  🔧 calculator:
     Описание: Perform a mathematical calculation
     Параметры: {"expression":{"type":"string","description":"..."}}
  🔧 searchKnowledge:
     Описание: Search for information in the knowledge base
     Параметры: {"query":{"type":"string","description":"..."}}
=== Конец проверки инструментов ===
```

## Как добавить новый инструмент

1. Откройте `src/tools/index.ts`
2. Добавьте новую функцию с `defineChatSessionFunction`:

```typescript
export const myNewTool = defineChatSessionFunction({
  description: 'Описание инструмента',
  params: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Описание параметра' }
    },
    required: ['param1']
  },
  async handler(params) {
    // ваша реализация
    return { result: 'результат', status: 'success' };
  }
});
```

3. Добавьте инструмент в экспорт:

```typescript
export const availableFunctions = {
  getWeather,
  calculator,
  searchKnowledge,
  myNewTool  // <-- добавляем сюда
};
```

4. Пересоберите проект: `npm run build`

## Тестовые вопросы для инструментов

В `question.service.ts` добавлены вопросы, которые должны триггерить использование инструментов:

- "Какая сейчас погода в Москве? Используй инструмент для проверки погоды."
- "Сколько будет 245 умножить на 37? Используй калькулятор."
- "Какая столица у Франции? Найди в базе знаний."
- "Посчитай 100 + 250 и скажи результат"

## Проверка работы

Запустите приложение с тестовыми вопросами:

```bash
npm start qwen2.5-1.5b-instruct-q5_k_m.gguf
```

Или используйте тест-раннер для тестирования всех моделей:

```bash
npm run test:models
```

В логах вы увидите информацию о зарегистрированных инструментах и их использовании.

## Важные замечания

1. **Модель должна поддерживать function calling** - не все модели поддерживают эту функциональность
2. **Инструменты вызываются автоматически** - модель сама решает, когда использовать инструмент
3. **Системный промпт важен** - фраза "You can use tools/functions when needed" помогает модели понять, что инструменты доступны
4. **Результаты инструментов логируются** - все вызовы и результаты можно отследить в логах

## Архитектура

```
src/tools/index.ts
    ↓ (экспорт availableFunctions)
src/services/llm.service.ts
    ↓ (передача в session.prompt)
node-llama-cpp LlamaChatSession
    ↓ (вызов handler при необходимости)
src/tools/index.ts (handler)
    ↓ (возврат результата)
модель → пользователь
```
