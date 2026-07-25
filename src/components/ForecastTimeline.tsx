'use client';

import React, { useState, useMemo } from 'react';
import { Calendar, ArrowUp, ArrowDown, AlertTriangle, ChevronDown, ChevronUp, List, Grid3X3 } from 'lucide-react';
import { ForecastEvent, ForecastSummary } from '@/types';
import { format, parseISO, isToday, isTomorrow, isThisWeek, startOfMonth, isSameMonth } from 'date-fns';

interface ForecastTimelineProps {
  forecast: ForecastSummary;
}

type ViewMode = 'daily' | 'monthly';

export default function ForecastTimeline({ forecast }: ForecastTimelineProps) {
  const [showAll, setShowAll] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  
  // Filter out starting balance
  const allEvents = forecast.events.filter(e => e.type !== 'starting_balance');
  const totalEvents = allEvents.length;

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
        <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
          <ArrowUp className="w-4 h-4 text-emerald-500" />
        </div>
      );
    }
    if (event.isCritical) {
      return (
        <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center">
          <AlertTriangle className="w-4 h-4 text-red-500" />
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-full bg-[var(--background-tertiary)] flex items-center justify-center">
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
      
      groups[monthKey].events.push(event);
      
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
    const events = showAll ? allEvents : allEvents.slice(0, 15);
    const groups: { [date: string]: ForecastEvent[] } = {};
    
    events.forEach(event => {
      if (!groups[event.date]) {
        groups[event.date] = [];
      }
      groups[event.date].push(event);
    });
    
    return groups;
  }, [allEvents, showAll]);

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
    <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-[var(--accent-tertiary)]/10 flex items-center justify-center border border-[var(--accent-tertiary)]/20">
            <Calendar className="w-6 h-6 text-[var(--accent-tertiary)]" />
          </div>
          <div>
            <h3 className="text-xl font-bold text-[var(--foreground)]">Transaction Timeline</h3>
            <p className="text-sm text-[var(--foreground-muted)] mt-0.5">{totalEvents} upcoming events</p>
          </div>
        </div>
        
        {/* View Mode Toggle */}
        <div className="flex items-center gap-1 p-1 bg-[var(--background-tertiary)] rounded-lg border border-[var(--border-color)]">
          <button
            onClick={() => setViewMode('daily')}
            className={`px-3 py-2 rounded-md transition-all flex items-center gap-2 ${
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
            className={`px-3 py-2 rounded-md transition-all flex items-center gap-2 ${
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
              <div key={monthKey} className="border border-[var(--border-color)] rounded-lg overflow-hidden">
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
                    {group.events.map((event, i) => (
                      <div
                        key={`${monthKey}-${i}`}
                        className={`flex items-center justify-between p-4 rounded-lg transition-all ${
                          event.isCritical
                            ? 'bg-red-500/10 border border-red-500/30'
                            : 'bg-[var(--background-secondary)] border border-[var(--border-color)]/50 hover:border-[var(--border-color)]'
                        }`}
                      >
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
                        <p className={`text-base font-bold ${
                          event.amount > 0 ? 'text-emerald-500' : 'text-[var(--foreground)]'
                        }`}>
                          {event.amount > 0 ? '+' : ''}${Math.abs(event.amount).toLocaleString()}
                        </p>
                      </div>
                    ))}
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
                  {dateEvents.map((event, i) => (
                    <div
                      key={`${date}-${i}`}
                      className={`flex items-center justify-between p-4 rounded-lg transition-all ${
                        event.isCritical
                          ? 'bg-red-500/10 border border-red-500/30'
                          : 'bg-[var(--background-tertiary)] border border-[var(--border-color)]/50 hover:border-[var(--border-color)]'
                      }`}
                    >
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
                      <p className={`text-base font-bold ${
                        event.amount > 0 ? 'text-emerald-500' : 'text-[var(--foreground)]'
                      }`}>
                        {event.amount > 0 ? '+' : ''}${Math.abs(event.amount).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {totalEvents > 15 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="w-full mt-6 py-3 text-sm font-semibold text-[var(--foreground-secondary)] hover:text-[var(--foreground)] flex items-center justify-center gap-2 transition-all border border-[var(--border-color)] rounded-lg hover:bg-[var(--background-tertiary)]"
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

