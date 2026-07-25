'use client';

import React, { useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { ForecastSummary } from '@/types';
import { format, parseISO } from 'date-fns';
import { TrendingDown, AlertTriangle } from 'lucide-react';

interface ForecastChartProps {
  forecast: ForecastSummary;
}

interface ChartDataPoint {
  date: string;
  displayDate: string;
  balance: number;
  isLowest: boolean;
  isCritical: boolean;
}

const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartDataPoint }> }) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload as ChartDataPoint;
    return (
      <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-lg p-3 shadow-lg">
        <p className="text-sm text-[var(--foreground-muted)] mb-1">{data.displayDate}</p>
        <p className={`text-lg font-bold ${data.isCritical ? 'text-red-500' : data.balance < 0 ? 'text-red-400' : 'text-[var(--foreground)]'}`}>
          ${data.balance.toLocaleString()}
        </p>
        {data.isLowest && (
          <p className="text-xs text-amber-500 mt-1 flex items-center gap-1">
            <TrendingDown className="w-3 h-3" />
            Lowest point
          </p>
        )}
        {data.isCritical && (
          <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            Below safety threshold
          </p>
        )}
      </div>
    );
  }
  return null;
};

export default function ForecastChart({ forecast }: ForecastChartProps) {
  const chartData = useMemo<ChartDataPoint[]>(() => {
    // Group events by date and get the end-of-day balance
    const balanceByDate: { [date: string]: { balance: number; isCritical: boolean } } = {};
    
    forecast.events.forEach(event => {
      balanceByDate[event.date] = {
        balance: event.balanceAfter,
        isCritical: event.isCritical || false,
      };
    });
    
    return Object.entries(balanceByDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({
        date,
        displayDate: format(parseISO(date), 'MMM d'),
        balance: data.balance,
        isLowest: date === forecast.lowestBalanceDate,
        isCritical: data.isCritical,
      }));
  }, [forecast]);

  const minBalance = Math.min(...chartData.map(d => d.balance), forecast.safetyThreshold);
  const maxBalance = Math.max(...chartData.map(d => d.balance));
  const yMin = Math.floor(minBalance / 500) * 500 - 500;
  const yMax = Math.ceil(maxBalance / 500) * 500 + 500;

  return (
    <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
        <div>
          <h3 className="text-xl font-bold text-[var(--foreground)] mb-1">Cash Flow Projection</h3>
          <p className="text-sm text-[var(--foreground-muted)]">Track your balance over time</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm bg-[var(--background-tertiary)] px-4 py-2.5 rounded-lg border border-[var(--border-color)]">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-[#c9a24e] shadow-sm" />
            <span className="text-[var(--foreground)] font-medium">Balance</span>
          </div>
          <div className="w-px h-4 bg-[var(--border-color)]" />
          <div className="flex items-center gap-2">
            <div className="w-6 h-0.5 bg-amber-500 border-dashed border-t-2 border-amber-500" />
            <span className="text-[var(--foreground)] font-medium">Safety ${forecast.safetyThreshold.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Key Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="p-4 rounded-lg bg-[var(--background-tertiary)] border border-[var(--border-color)]/50">
          <p className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide mb-2">Starting Balance</p>
          <p className="text-2xl font-bold text-emerald-500">
            ${forecast.startingBalance.toLocaleString()}
          </p>
        </div>
        <div className="p-4 rounded-lg bg-[var(--background-tertiary)] border border-[var(--border-color)]/50">
          <p className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide mb-2">Lowest Point</p>
          <p className={`text-2xl font-bold ${forecast.lowestBalance < forecast.safetyThreshold ? 'text-red-500' : forecast.lowestBalance < forecast.safetyThreshold * 1.5 ? 'text-amber-500' : 'text-[var(--foreground)]'}`}>
            ${forecast.lowestBalance.toLocaleString()}
          </p>
          <p className="text-xs text-[var(--foreground-muted)] mt-1">
            {format(parseISO(forecast.lowestBalanceDate), 'MMM d, yyyy')}
          </p>
        </div>
        <div className="p-4 rounded-lg bg-[var(--background-tertiary)] border border-[var(--border-color)]/50">
          <p className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide mb-2">Ending Balance</p>
          <p className="text-2xl font-bold text-[var(--foreground)]">
            ${forecast.endingBalance.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Warning if below safety */}
      {forecast.daysUntilUnsafe !== null && (
        <div className="mb-6 p-4 rounded-lg bg-amber-500/10 border-2 border-amber-500/40 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-200 mb-1">Low Balance Alert</p>
            <p className="text-sm text-amber-200/90">
              Balance will drop below your safety threshold of ${forecast.safetyThreshold.toLocaleString()} in <span className="font-bold">{forecast.daysUntilUnsafe} days</span>.
            </p>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="h-[350px] mt-4">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
            <defs>
              <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#c9a24e" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#c9a24e" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} opacity={0.5} />
            <XAxis
              dataKey="displayDate"
              stroke="var(--foreground-muted)"
              fontSize={13}
              fontWeight={500}
              tickLine={false}
              axisLine={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
              interval="preserveStartEnd"
              dy={10}
            />
            <YAxis
              stroke="var(--foreground-muted)"
              fontSize={13}
              fontWeight={500}
              tickLine={false}
              axisLine={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
              domain={[yMin, yMax]}
              tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
              dx={-5}
            />
            <Tooltip content={<CustomTooltip />} />
            
            {/* Safety threshold line */}
            <ReferenceLine
              y={forecast.safetyThreshold}
              stroke="#f59e0b"
              strokeDasharray="5 5"
              strokeWidth={2}
            />
            
            {/* Zero line */}
            <ReferenceLine
              y={0}
              stroke="#ef4444"
              strokeWidth={1}
            />
            
            <Area
              type="monotone"
              dataKey="balance"
              stroke="#c9a24e"
              strokeWidth={3}
              fill="url(#balanceGradient)"
              dot={(props: any) => {
                const { cx, cy, payload } = props;
                if (payload.isLowest) {
                  return (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={7}
                      fill={payload.isCritical ? '#ef4444' : '#f59e0b'}
                      stroke="#fff"
                      strokeWidth={3}
                    />
                  );
                }
                return null;
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

