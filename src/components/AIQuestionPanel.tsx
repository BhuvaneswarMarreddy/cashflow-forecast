'use client';

import React, { useState } from 'react';
import { MessageSquare, Send, Loader2, RefreshCw } from 'lucide-react';
import { ForecastSummary } from '@/types';
import { prepareForecastForAI } from '@/lib/forecast';
import { aiDecision } from '@/lib/callables';

interface AIQuestionPanelProps {
  forecast: ForecastSummary;
}

interface Message {
  type: 'user' | 'ai';
  content: string;
}

const SUGGESTED_QUESTIONS = [
  "Why is my balance low next month?",
  "When is my next income?",
  "What bills are coming up?",
  "Am I safe for the next 30 days?",
];

export default function AIQuestionPanel({ forecast }: AIQuestionPanelProps) {
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const askQuestion = async (q: string) => {
    if (!q.trim()) return;

    const userQuestion = q.trim();
    setQuestion('');
    setMessages(prev => [...prev, { type: 'user', content: userQuestion }]);
    setIsLoading(true);

    try {
      const data = await aiDecision({
        type: 'question',
        forecastData: prepareForecastForAI(forecast),
        question: userQuestion,
      });

      if (data.explanation) {
        setMessages(prev => [...prev, { type: 'ai', content: data.explanation }]);
      } else {
        setMessages(prev => [...prev, { 
          type: 'ai', 
          content: 'I could not process that question. Please try rephrasing it.' 
        }]);
      }
    } catch (err) {
      console.error('AI question failed:', err);
      setMessages(prev => [...prev, { 
        type: 'ai', 
        content: 'Unable to get an answer right now. Please check your forecast data directly.' 
      }]);
    }

    setIsLoading(false);
  };

  const clearChat = () => {
    setMessages([]);
    setQuestion('');
  };

  return (
    <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--accent-secondary)]/10 flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-[var(--accent-secondary)]" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-[var(--foreground)]">Ask About Your Finances</h3>
            <p className="text-sm text-[var(--foreground-muted)]">Get clear explanations about your forecast</p>
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] transition-colors"
            title="Clear chat"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Suggested Questions */}
      {messages.length === 0 && (
        <div className="mb-4">
          <p className="text-xs text-[var(--foreground-muted)] mb-2">Try asking:</p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_QUESTIONS.map((sq, i) => (
              <button
                key={i}
                onClick={() => askQuestion(sq)}
                className="px-3 py-1.5 text-sm rounded-full bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:bg-[var(--accent-primary)]/10 hover:text-[var(--accent-primary)] transition-colors"
              >
                {sq}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      {messages.length > 0 && (
        <div className="mb-4 max-h-[300px] overflow-y-auto space-y-3">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`p-3 rounded-lg ${
                msg.type === 'user'
                  ? 'bg-[var(--accent-primary)]/10 ml-8'
                  : 'bg-[var(--background-tertiary)] mr-8'
              }`}
            >
              <p className="text-xs text-[var(--foreground-muted)] mb-1">
                {msg.type === 'user' ? 'You' : 'Assistant'}
              </p>
              <p className="text-sm text-[var(--foreground-secondary)] leading-relaxed">
                {msg.content}
              </p>
            </div>
          ))}
          {isLoading && (
            <div className="p-3 rounded-lg bg-[var(--background-tertiary)] mr-8">
              <div className="flex items-center gap-2 text-[var(--foreground-muted)]">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Analyzing your forecast...</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about your finances..."
          className="input-field flex-1"
          onKeyDown={(e) => e.key === 'Enter' && !isLoading && askQuestion(question)}
          disabled={isLoading}
        />
        <button
          onClick={() => askQuestion(question)}
          disabled={!question.trim() || isLoading}
          className="btn-primary px-4 disabled:opacity-50"
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}

