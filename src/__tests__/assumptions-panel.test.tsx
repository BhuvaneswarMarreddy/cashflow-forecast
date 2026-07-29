import React from 'react';
import { render, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AssumptionsPanel from '@/components/AssumptionsPanel';
import { Assumptions } from '@/lib/behavior';

const assumptions: Assumptions = {
  income: { label: 'Canton Group', medianAmount: 4339, cadence: 'biweekly', nextDate: '2026-08-07', confidence: 0.9 },
  fixedBills: [
    { merchant: 'VERIZON', amount: 49.99, cadence: 'monthly', nextDue: '2026-08-14', accountId: 'b1', confidence: 0.85 },
  ],
  categoryBaselines: [
    { category: 'Groceries', monthlyMedian: 560, monthsObserved: 6 },
    { category: 'Dining', monthlyMedian: 240, monthsObserved: 5 },
  ],
  exclusions: {
    transfers: 18, cardPayments: 12, refunds: 3,
    oneTimes: [{ id: 'tv', title: 'Best Buy TV', amount: 1400, date: '2026-05-02' }],
  },
  overrides: {},
};

describe('AssumptionsPanel', () => {
  it('renders income, bills, baselines, and the exclusion ledger', () => {
    const { getByText } = render(<AssumptionsPanel assumptions={assumptions} onOverridesChange={() => {}} />);
    expect(getByText(/Canton Group/)).toBeInTheDocument();
    expect(getByText(/every 2 weeks/)).toBeInTheDocument();
    expect(getByText('VERIZON')).toBeInTheDocument();
    expect(getByText(/next due Aug 14/)).toBeInTheDocument();
    expect(getByText(/\$560\/mo/)).toBeInTheDocument();
    expect(getByText(/18 transfers · 12 card payments · 3 refunds/)).toBeInTheDocument();
    expect(getByText(/Best Buy TV/)).toBeInTheDocument(); // one-time visible inside the details list
  });

  it('editing a bill amount commits an override on blur', () => {
    const onChange = jest.fn();
    const { getByLabelText } = render(<AssumptionsPanel assumptions={assumptions} onOverridesChange={onChange} />);
    const input = getByLabelText('VERIZON amount in dollars') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '55' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ bills: { VERIZON: { amount: 55 } } }));
  });

  it('disable bill / remove income / remove baseline write the right overrides', () => {
    const onChange = jest.fn();
    const { getByLabelText, getByRole } = render(<AssumptionsPanel assumptions={assumptions} onOverridesChange={onChange} />);
    fireEvent.click(getByLabelText('Disable VERIZON in the forecast'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ bills: { VERIZON: { disabled: true } } }));
    fireEvent.click(within(getByRole('region', { name: 'Income assumption' })).getByText('Remove'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ income: null }));
    fireEvent.click(getByLabelText('Remove Groceries baseline from the forecast'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ baselines: { Groceries: null } }));
  });

  it('removed income shows the Undo affordance that clears the override', () => {
    const onChange = jest.fn();
    const removed: Assumptions = { ...assumptions, income: null, overrides: { income: null } };
    const { getByText } = render(<AssumptionsPanel assumptions={removed} onOverridesChange={onChange} />);
    expect(getByText(/Income removed from the forecast/)).toBeInTheDocument();
    fireEvent.click(getByText('Undo'));
    expect(onChange).toHaveBeenCalledWith(expect.not.objectContaining({ income: null }));
  });
});
