import type { IQuestionService } from '@types-def/services.types.js';

/**
 * Predefined questions for testing
 */
const QUESTIONS: string[] = [
  'Напиши рецепт любого блюда на 50 слов',
  'Напиши сказку на 50 слов',
  'Напиши поздравление мужчине с днем рождения на 50 слов',
  'Напиши поздравление женщине с днем рождения на 50 слов',
  'Какая сейчас погода в Москве? Используй инструмент для проверки погоды.',
  'Сколько будет 245 умножить на 37? Используй калькулятор.',
  'Какая столица у Франции? Найди в базе знаний.',
  'Посчитай 100 + 250 и скажи результат'
];

export class QuestionService implements IQuestionService {
  /**
   * Get a random question from the predefined list
   */
  getRandomQuestion(): string {
    const randomIndex = Math.floor(Math.random() * QUESTIONS.length);
    return QUESTIONS[randomIndex];
  }
}
