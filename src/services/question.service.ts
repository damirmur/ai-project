import type { IQuestionService } from '@types-def/services.types.js';

/**
 * Questions for testing LLM models — Node.js 24 development scenarios
 */
const QUESTIONS: string[] = [
  // Категория 1: Генерация кода
  'Напиши функцию на TypeScript для чтения JSON-файла с обработкой ошибок',
  'Создай класс Logger с методами info/warn/error и записью в файл',
  'Напиши middleware для валидации входных данных объекта',
  'Реализуй кэш с TTL (time-to-live) на Map',
  'Напиши функцию debounce на TypeScript',

  // Категория 2: Архитектура
  'Как организовать конфигурацию приложения с .env и fallback-значениями?',
  'Опиши структуру проекта на Node.js с сервисами и зависимостями',
  'Как реализовать систему плагинов для Node.js приложения?',
  'Напиши пример dependency injection контейнера',
  'Как организовать graceful shutdown для Node.js сервиса?',

  // Категория 3: Отладка и troubleshooting
  'Процесс Node.js потребляет 100% CPU — как диагностировать?',
  'Утечка памяти в долгоживущем процессе — как найти?',
  'Promise не завершается — как отладить?',
  'ESM модуль не импортируется — возможные причины?',
  'Child process завис — как корректно завершить?',

  // Категория 4: Async/await и производительность
  'Напиши функцию для параллельного запуска 5 задач с ограничением Concurrency до 2',
  'Как реализовать streaming response для HTTP-сервера?',
  'Напиши retry-логику с exponential backoff',
  'Как обработать 10000 запросов без блокировки event loop?',
  'Реализуй Worker Threads для CPU-задачи',

  // Категория 5: TypeScript и типизация
  'Напиши generic-функцию, которая возвращает значение указанного типа из JSON',
  'Создай discriminated union для обработки разных типов событий',
  'Как типизировать EventEmitter с разными событиями?',
  'Напиши type guard для проверки что объект implements интерфейс',
  'Создай utility type для Partial<T> но с обязательными ID',

  // Категория 6: Работа с внешними ресурсами
  'Напиши HTTP-клиент с timeout и retry',
  'Как читать большой файл построчно без загрузки в память?',
  'Напиши функцию для exec с timeout и abort',
  'Как подключиться к SQLite и выполнить миграции?',
  'Реализуй watch за директорией с debounce событий',

  // Категория 7: Практические задачи (похожие на твой проект)
  'Напиши сервис для загрузки LLM-модели с мониторингом памяти',
  'Создай систему логирования с разными уровнями и записью в файл',
  'Напиши CLI-приложение с аргументами и subcommands',
  'Реализуй супервизор для управления дочерними процессами',
  'Напиши генератор отчётов в Markdown и JSON'
];

export class QuestionService implements IQuestionService {
  /**
   * Get a random question from the predefined list
   */
  getRandomQuestion(): string {
    const randomIndex = Math.floor(Math.random() * QUESTIONS.length);
    return QUESTIONS[randomIndex];
  }

  /**
   * Get all available questions
   */
  getAllQuestions(): string[] {
    return [...QUESTIONS];
  }
}
