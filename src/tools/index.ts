import { defineChatSessionFunction } from 'node-llama-cpp';
import { logToolCall, logToolResult } from './logger.js';

/**
 * Пример базы данных городов с температурой
 */
const cityWeather: Record<string, number> = {
  'moscow': 15,
  'london': 12,
  'paris': 18,
  'tokyo': 25,
  'new york': 20
};

/**
 * Пример базы данных с информацией
 */
const knowledgeBase: Record<string, string> = {
  'capital of russia': 'Moscow',
  'capital of france': 'Paris',
  'capital of japan': 'Tokyo'
};

/**
 * Инструмент: Получение погоды в городе
 */
export const getWeather = defineChatSessionFunction({
  description: 'Get the current temperature in a city',
  params: {
    type: 'object',
    properties: {
      city: { 
        type: 'string',
        description: 'City name (e.g., Moscow, London, Tokyo)'
      }
    },
    required: ['city']
  },
  async handler(params) {
    const city = params.city.toLowerCase();
    
    // Логирование вызова инструмента
    logToolCall('getWeather', { city: params.city });
    
    if (cityWeather[city] !== undefined) {
      const temperature = cityWeather[city];
      const result = { 
        city: params.city, 
        temperature: `${temperature}°C`,
        status: 'found'
      };
      logToolResult('getWeather', result);
      return result;
    }
    
    const result = { 
      city: params.city, 
      temperature: 'unknown',
      status: 'not found in database'
    };
    logToolResult('getWeather', result);
    return result;
  }
});

/**
 * Инструмент: Калькулятор
 */
export const calculator = defineChatSessionFunction({
  description: 'Perform a mathematical calculation',
  params: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Mathematical expression (e.g., "2 + 2", "10 * 5")'
      }
    },
    required: ['expression']
  },
  async handler(params) {
    try {
      const expression = params.expression;
      
      // Логирование вызова инструмента
      logToolCall('calculator', { expression });
      
      // Простая проверка безопасности - разрешаем только цифры и операторы
      if (!/^[0-9\s\+\-\*\/\(\)\.]+$/.test(expression)) {
        const result = { 
          expression, 
          result: 'error: invalid expression',
          status: 'error'
        };
        logToolResult('calculator', result);
        return result;
      }
      
      // Безопасное вычисление (только простые выражения)
      const resultValue = Function('"use strict"; return (' + expression + ')')();
      
      const result = { 
        expression, 
        result: String(resultValue),
        status: 'success'
      };
      logToolResult('calculator', result);
      return result;
    } catch (error) {
      const result = { 
        expression: params.expression,
        result: 'error: could not evaluate',
        status: 'error'
      };
      logToolResult('calculator', result);
      return result;
    }
  }
});

/**
 * Инструмент: Поиск информации
 */
export const searchKnowledge = defineChatSessionFunction({
  description: 'Search for information in the knowledge base',
  params: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (e.g., "capital of russia")'
      }
    },
    required: ['query']
  },
  async handler(params) {
    const query = params.query.toLowerCase();
    
    // Логирование вызова инструмента
    logToolCall('searchKnowledge', { query: params.query });
    
    for (const [key, value] of Object.entries(knowledgeBase)) {
      if (query.includes(key) || key.includes(query)) {
        const result = {
          query: params.query,
          result: value,
          status: 'found'
        };
        logToolResult('searchKnowledge', result);
        return result;
      }
    }
    
    const result = {
      query: params.query,
      result: 'no information found',
      status: 'not found'
    };
    logToolResult('searchKnowledge', result);
    return result;
  }
});

/**
 * Экспорт всех инструментов в одном объекте
 */
export const availableFunctions = {
  getWeather,
  calculator,
  searchKnowledge
};

/**
 * Список названий инструментов (для логирования)
 */
export const functionNames = Object.keys(availableFunctions);
