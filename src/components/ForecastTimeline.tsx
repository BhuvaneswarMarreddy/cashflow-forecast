'use client';

import React, { useState, useMemo } from 'react';
import { Calendar, ArrowUp, ArrowDown, AlertTriangle, ChevronDown, ChevronUp, List, Grid3X3 } from 'lucide-react';
import { ForecastEvent, ForecastSummary } from '@/types';
import { formatMoney } from '@/lib/money';
import { LIVING_COSTS_LABEL } from '@/lib/behavior';
import { format, parseISO, isToday, isTomorrow, isThisWeek, startOfMonth, isSameMonth } from 'date-fns';

// Projected events can explain themselves (breakdown/confidence/contributors).
const isExplainable = (e: ForecastEvent) =>
  e.source === 'projected' || !!e.breakdown || e.confidence !== undefined;

// The quiet expansion body shared by both views.
const explainBlock = (event: ForecastEvent) => (
  <div className="mt-2 ml-11 space-y-1 text-xs text-[var(--foreground-muted)]">
    {event.breakdown?.map((b) => (
      <p key={b.label} className="flex items-center justify-between gap-4">
        <span>{b.label}</span>
        {/* breakdown amounts are MONTHLY baselines; the event amount is the daily slice */}
        <span className="tabular-nums">{formatMoney(b.amount)}/mo</span>
      </p>
    ))}
    {event.confidence !== undefined && <p>Confidence: {Math.round(event.confidence * 100)}%</p>}
    {event.contributors && event.contributors.length > 0 && (
      <p>Based on: {event.contributors.join(', ')}</p>
    )}
  </div>
);

interface ForecastTimelineProps {
  forecast: ForecastSummary;
}

type ViewMode = 'daily' | 'monthly';

export default function ForecastTimeline({ forecast }: ForecastTimelineProps) {
  const [showAll, setShowAll] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  
  // Filter out starting balance
  const allEvents = forecast.events.filter(e => e.type !== 'starting_balance');
  // The daily living-costs drain stays in the MATH (balances/chart) but renders as
  // ONE explainable strip, not 90 identical rows drowning the real events.
  const livingEvents = allEvents.filter(e => e.description === LIVING_COSTS_LABEL);
  const discreteEvents = allEvents.filter(e => e.description !== LIVING_COSTS_LABEL);
  const livingDaily = livingEvents.length > 0 ? Math.abs(livingEvents[0].amount) : 0;
  const totalEvents = discreteEvents.length;

  const getDateLabel = (dateStr: string) => {
    const date = parseISO(dateStr);
    if (isToday(date)) return 'Today';
    if (isTomorrow(date)) return 'Tomorrow';
    if (isThisWeek(date)) return format(date, 'EEEE');
    return format(date, 'MMM d');
  };

  const getEventIcon = (event: ForecastEvent) => {
    if (event.amount > 0) {
      return (
        <div className="w-8 h-8 rounded-pill bg-emerald-500/20 flex items-center justify-center">
          <ArrowUp className="w-4 h-4 text-emerald-500" />
        </div>
      );
    }
    if (event.isCritical) {
      return (
        <div className="w-8 h-8 rounded-pill bg-red-500/20 flex items-center justify-center">
          <AlertTriangle className="w-4 h-4 text-red-500" />
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-pill bg-[var(--background-tertiary)] flex items-center justify-center">
        <ArrowDown className="w-4 h-4 text-[var(--foreground-muted)]" />
      </div>
    );
  };

  // Group events by month for monthly view
  const monthlyGroups = useMemo(() => {
    const groups: { [monthKey: string]: { 
      month: Date; 
      events: ForecastEvent[]; 
      totalIncome: number; 
      totalExpenses: number;
      endBalance: number;
    } } = {};
    
    allEvents.forEach(event => {
      const date = parseISO(event.date);
      const monthKey = format(date, 'yyyy-MM');
      
      if (!groups[monthKey]) {
        groups[monthKey] = {
          month: startOfMonth(date),
          events: [],
          totalIncome: 0,
          totalExpenses: 0,
          endBalance: 0,
        };
      }
      
      // living-costs rows are folded into totals/balances only, never listed
      if (event.description !== LIVING_COSTS_LABEL) groups[monthKey].events.push(event);

      if (event.amount > 0) {
        groups[monthKey].totalIncome += event.amount;
      } else {
        groups[monthKey].totalExpenses += Math.abs(event.amount);
      }
      
      groups[monthKey].endBalance = event.balanceAfter;
    });
    
    return Object.values(groups).sort((a, b) => a.month.getTime() - b.month.getTime());
  }, [allEvents]);

  // Group events by date for daily view
  const dailyGroups = useMemo(() => {
    const events = showAll ? discreteEvents : discreteEvents.slice(0, 15);
    const groups: { [date: string]: ForecastEvent[] } = {};
    
    events.forEach(event => {
      if (!groups[event.date]) {
        groups[event.date] = [];
      }
      groups[event.date].push(event);
    });
    
    return groups;
  }, [discreteEvents, showAll]);

  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  const toggleMonth = (monthKey: string) => {
    setExpandedMonths(prev => {
      const next = new Set(prev);
      if (next.has(monthKey)) {
        next.delete(monthKey);
      } else {
        next.add(monthKey);
      }
      return next;
    });
  };

  return (
    <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-card p-6 shadow-sm">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-card bg-[var(--accent-tertiary)]/10 flex items-center justify-center border border-[var(--accent-tertiary)]/20">
            <Calendar className="w-6 h-6 text-[var(--accent-tertiary)]" />
          </div>
          <div>
            <h3 className="text-xl font-bold text-[var(--foreground)]">Transaction Timeline</h3>
            <p className="text-sm text-[var(--foreground-muted)] mt-1">{totalEvents} upcoming events</p>
          </div>
        </div>
        
        {/* View Mode Toggle */}
        <div className="flex items-center gap-1 p-1 bg-[var(--background-tertiary)] rounded-control border border-[var(--border-color)]">
          <button
            onClick={() => setViewMode('daily')}
            className={`px-3 py-2 rounded-control transition-all flex items-center gap-2 ${
              viewMode === 'daily'
                ? 'bg-[var(--accent-primary)] text-[#16181c] shadow-sm'
                : 'text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background-secondary)]'
            }`}
            title="Daily View"
          >
            <List className="w-4 h-4" />
            <span className="text-sm font-medium hidden sm:inline">Daily</span>
          </button>
          <button
            onClick={() => setViewMode('monthly')}
            className={`px-3 py-2 rounded-control transition-all flex items-center gap-2 ${
              viewMode === 'monthly'
                ? 'bg-[var(--accent-primary)] text-[#16181c] shadow-sm'
                : 'text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background-secondary)]'
            }`}
            title="Monthly View"
          >
            <Grid3X3 className="w-4 h-4" />
            <span className="text-sm font-medium hidden sm:inline">Monthly</span>
          </button>
        </div>
      </div>

      {/* Living costs: one explainable strip instead of a row per day */}
      {livingDaily > 0 && (
        <details className="mb-6 -mt-2 rounded-control bg-[var(--background-tertiary)]/50 border border-[var(--border-color)]">
          <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden min-h-[44px] px-3 flex items-center gap-2 text-sm text-[var(--foreground-secondary)]">
            <span aria-hidden="true">≈</span>
            All balances below include projected living costs of{' '}
            <span className="font-semibold text-[var(--foreground)] tabular-nums">{formatMoney(livingDaily, 'USD', 2)}/day</span>
            <span className="ml-auto text-xs text-[var(--foreground-muted)]">what&apos;s in this?</span>
          </summary>
          <div className="px-3 pb-3 space-y-1 text-xs text-[var(--foreground-muted)]">
            {livingEvents[0]?.breakdown?.map((b) => (
              <p key={b.label} className="flex items-center justify-between gap-4">
                <span>{b.label}</span>
                <span className="tabular-nums">{formatMoney(b.amount)}/mo</span>
              </p>
            ))}
            {livingEvents[0]?.confidence !== undefined && (
              <p>Confidence: {Math.round((livingEvents[0].confidence ?? 0) * 100)}%</p>
            )}
            <p>Adjust any of this in “What this forecast believes” above.</p>
          </div>
        </details>
      )}

      {/* Monthly View */}
      {viewMode === 'monthly' && (
        <div className="space-y-3">
          {monthlyGroups.map((group) => {
            const monthKey = format(group.month, 'yyyy-MM');
            const isExpanded = expandedMonths.has(monthKey);
            const netChange = group.totalIncome - group.totalExpenses;
            const lowestInMonth = Math.min(...group.events.map(e => e.balanceAfter));
            const hasWarning = group.events.some(e => e.isCritical);
            
            return (
              <div key={monthKey} className="border border-[var(--border-color)] rounded-control overflow-hidden">
                {/* Month Header */}
                <button
                  onClick={() => toggleMonth(monthKey)}
                  className={`w-full p-5 flex items-center justify-between ${
                    hasWarning ? 'bg-amber-500/10' : 'bg-[var(--background-tertiary)]'
                  } hover:bg-[var(--background-tertiary)]/80 transition-colors`}
                >
                  <div className="flex items-center gap-3">
                    <div className="text-left">
                      <p className="font-bold text-base text-[var(--foreground)]">
                        {format(group.month, 'MMMM yyyy')}
                      </p>
                      <p className="text-xs text-[var(--foreground-muted)] mt-1">
                        {group.events.length} transactions
                      </p>
                    </div>
                    {hasWarning && (
                      <AlertTriangle className="w-5 h-5 text-amber-500" />
                    )}
                  </div>
                  
                  <div className="flex items-center gap-5">
                    <div className="text-right hidden sm:block">
                      <div className="flex gap-4 text-sm font-semibold mb-1">
                        <span className="text-emerald-500">+${group.totalIncome.toLocaleString()}</span>
                        <span className="text-red-400">-${group.totalExpenses.toLocaleString()}</span>
                      </div>
                      <p className={`text-xs font-medium ${netChange >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                        Net: {netChange >= 0 ? '+' : ''}${netChange.toLocaleString()}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-[var(--foreground-muted)] mb-1">End Balance</p>
                      <p className={`font-bold text-lg ${group.endBalance < 0 ? 'text-red-500' : 'text-[var(--foreground)]'}`}>
                        ${group.endBalance.toLocaleString()}
                      </p>
                    </div>
                    {isExpanded ? (
                      <ChevronUp className="w-5 h-5 text-[var(--foreground-muted)]" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-[var(--foreground-muted)]" />
                    )}
                  </div>
                </button>
                
                {/* Month Events */}
                {isExpanded && (
                  <div className="p-4 border-t border-[var(--border-color)] space-y-3 max-h-[400px] overflow-y-auto">
                    {group.events.map((event, i) => {
                      const rowClass = `p-4 rounded-control transition-all ${
                        event.isCritical
                          ? 'bg-red-500/10 border border-red-500/30'
                          : 'bg-[var(--background-secondary)] border border-[var(--border-color)]/50 hover:border-[var(--border-color)]'
                      }`;
                      const content = (
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {getEventIcon(event)}
                            <div>
                              <p className="text-sm font-semibold text-[var(--foreground)] mb-1">
                                {event.description}
                              </p>
                              <p className="text-xs text-[var(--foreground-muted)]">
                                {format(parseISO(event.date), 'MMM d, yyyy')} • Balance: <span className="font-medium">${event.balanceAfter.toLocaleString()}</span>
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <p className={`text-base font-bold ${
                              event.amount > 0 ? 'text-emerald-500' : 'text-[var(--foreground)]'
                            }`}>
                              {event.amount > 0 ? '+' : ''}${Math.abs(event.amount).toLocaleString()}
                            </p>
                            {isExplainable(event) && (
                              <ChevronDown className="w-4 h-4 text-[var(--foreground-muted)] transition-transform group-open:rotate-180" aria-hidden="true" />
                            )}
                          </div>
                        </div>
                      );
                      return isExplainable(event) ? (
                        <details key={`${monthKey}-${i}`} className={`group ${rowClass}`}>
                          <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                            {content}
                          </summary>
                          {explainBlock(event)}
                        </details>
                      ) : (
                        <div key={`${monthKey}-${i}`} className={rowClass}>{content}</div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Daily View */}
      {viewMode === 'daily' && (
        <>
          <div className="space-y-4">
            {Object.entries(dailyGroups).map(([date, dateEvents]) => (
              <div key={date} className="relative">
                {/* Date Header */}
                <div className="sticky top-0 bg-[var(--background-secondary)] py-3 z-10 border-b border-[var(--border-color)]/30">
                  <p className="text-xs font-bold text-[var(--foreground-muted)] uppercase tracking-wider">
                    {getDateLabel(date)} <span className="text-[var(--foreground-muted)]/60 font-normal">• {format(parseISO(date), 'MMM d, yyyy')}</span>
                  </p>
                </div>

                {/* Events for this date */}
                <div className="space-y-3 ml-3 border-l-2 border-[var(--border-color)] pl-5 pt-3">
                  {dateEvents.map((event, i) => {
                    const rowClass = `p-4 rounded-control transition-all ${
                      event.isCritical
                        ? 'bg-red-500/10 border border-red-500/30'
                        : 'bg-[var(--background-tertiary)] border border-[var(--border-color)]/50 hover:border-[var(--border-color)]'
                    }`;
                    const content = (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {getEventIcon(event)}
                          <div>
                            <p className="text-sm font-semibold text-[var(--foreground)] mb-1">
                              {event.description}
                            </p>
                            <p className="text-xs text-[var(--foreground-muted)]">
                              Balance after: <span className="font-medium">${event.balanceAfter.toLocaleString()}</span>
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <p className={`text-base font-bold ${
                            event.amount > 0 ? 'text-emerald-500' : 'text-[var(--foreground)]'
                          }`}>
                            {event.amount > 0 ? '+' : ''}${Math.abs(event.amount).toLocaleString()}
                          </p>
                          {isExplainable(event) && (
                            <ChevronDown className="w-4 h-4 text-[var(--foreground-muted)] transition-transform group-open:rotate-180" aria-hidden="true" />
                          )}
                        </div>
                      </div>
                    );
                    return isExplainable(event) ? (
                      <details key={`${date}-${i}`} className={`group ${rowClass}`}>
                        <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                          {content}
                        </summary>
                        {explainBlock(event)}
                      </details>
                    ) : (
                      <div key={`${date}-${i}`} className={rowClass}>{content}</div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {totalEvents > 15 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="w-full mt-6 py-3 text-sm font-semibold text-[var(--foreground-secondary)] hover:text-[var(--foreground)] flex items-center justify-center gap-2 transition-all border border-[var(--border-color)] rounded-control hover:bg-[var(--background-tertiary)]"
            >
              {showAll ? (
                <>
                  Show Less <ChevronUp className="w-4 h-4" />
                </>
              ) : (
                <>
                  Show All {totalEvents} Events <ChevronDown className="w-4 h-4" />
                </>
              )}
            </button>
          )}
        </>
      )}

      {totalEvents === 0 && (
        <div className="text-center py-8 text-[var(--foreground-muted)]">
          <Calendar className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>No upcoming events</p>
          <p className="text-sm">Add income sources and bills to see your forecast</p>
        </div>
      )}
    </div>
  );
}

