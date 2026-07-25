'use client';

import { useState, useEffect, useCallback } from 'react';
import { format, parseISO, startOfMonth, endOfMonth, addMonths, isSameMonth } from 'date-fns';
import { 
  Plus, 
  Check, 
  X, 
  Calendar, 
  DollarSign, 
  ChevronLeft, 
  ChevronRight,
  Edit2,
  Trash2,
  CheckCircle,
  Clock,
  AlertCircle,
  XCircle,
  RefreshCw
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { 
  PlannedTransaction, 
  PlannedTransactionStatus,
  ExpenseCategory,
  EXPENSE_CATEGORIES 
} from '@/types';
import { 
  addPlannedTransaction, 
  getPlannedTransactions, 
  updatePlannedTransaction,
  deletePlannedTransaction,
  completePlannedTransaction,
  addTransaction
} from '@/lib/firestore';
import { useUserProfile } from '@/context/UserProfileContext';

export default function PlannedPaymentsPanel() {
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const [planned, setPlanned] = useState<PlannedTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  
  // Form state
  const [formData, setFormData] = useState({
    title: '',
    amount: '',
    type: 'expense' as 'expense' | 'income',
    category: 'other' as ExpenseCategory,
    accountId: '',
    dueDate: format(new Date(), 'yyyy-MM-dd'),
    notes: '',
    priority: 'medium' as 'high' | 'medium' | 'low',
    isRecurring: false,
    recurringFrequency: 'monthly' as 'weekly' | 'monthly' | 'yearly',
  });

  const fetchPlanned = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await getPlannedTransactions(user.id);
      setPlanned(data);
    } catch (error) {
      console.error('Error fetching planned transactions:', error);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchPlanned();
  }, [fetchPlanned]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !formData.title || !formData.amount) return;

    try {
      const plannedData = {
        title: formData.title,
        amount: parseFloat(formData.amount),
        type: formData.type,
        category: formData.category,
        accountId: formData.accountId || undefined,
        dueDate: formData.dueDate,
        notes: formData.notes || undefined,
        priority: formData.priority,
        status: 'pending' as PlannedTransactionStatus,
        isRecurring: formData.isRecurring,
        recurringFrequency: formData.isRecurring ? formData.recurringFrequency : undefined,
      };

      if (editingId) {
        await updatePlannedTransaction(user.id, editingId, plannedData);
      } else {
        await addPlannedTransaction(user.id, plannedData);
      }

      // Reset form
      setFormData({
        title: '',
        amount: '',
        type: 'expense',
        category: 'other',
        accountId: '',
        dueDate: format(new Date(), 'yyyy-MM-dd'),
        notes: '',
        priority: 'medium',
        isRecurring: false,
        recurringFrequency: 'monthly',
      });
      setShowAddForm(false);
      setEditingId(null);
      fetchPlanned();
    } catch (error) {
      console.error('Error saving planned transaction:', error);
    }
  };

  const handleComplete = async (item: PlannedTransaction, createTransaction: boolean) => {
    if (!user) return;

    try {
      let transactionId: string | undefined;

      if (createTransaction) {
        // Create actual transaction
        transactionId = await addTransaction(user.id, {
          title: item.title,
          amount: item.amount,
          type: item.type,
          category: item.category,
          paymentMethod: 'other',
          accountId: item.accountId,
          date: new Date().toISOString(),
          description: item.notes,
        });
      }

      await completePlannedTransaction(user.id, item.id, transactionId);
      fetchPlanned();
    } catch (error) {
      console.error('Error completing planned transaction:', error);
    }
  };

  const handleSkip = async (itemId: string) => {
    if (!user) return;
    try {
      await updatePlannedTransaction(user.id, itemId, { status: 'skipped' });
      fetchPlanned();
    } catch (error) {
      console.error('Error skipping planned transaction:', error);
    }
  };

  const handleDelete = async (itemId: string) => {
    if (!user) return;
    if (!confirm('Delete this planned payment?')) return;
    try {
      await deletePlannedTransaction(user.id, itemId);
      fetchPlanned();
    } catch (error) {
      console.error('Error deleting planned transaction:', error);
    }
  };

  const handleEdit = (item: PlannedTransaction) => {
    setFormData({
      title: item.title,
      amount: item.amount.toString(),
      type: item.type,
      category: item.category,
      accountId: item.accountId || '',
      dueDate: format(parseISO(item.dueDate), 'yyyy-MM-dd'),
      notes: item.notes || '',
      priority: item.priority,
      isRecurring: item.isRecurring || false,
      recurringFrequency: item.recurringFrequency || 'monthly',
    });
    setEditingId(item.id);
    setShowAddForm(true);
  };

  // Filter for current month
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  
  const monthPlanned = planned.filter(p => {
    const date = parseISO(p.dueDate);
    return date >= monthStart && date <= monthEnd;
  });

  const pendingItems = monthPlanned.filter(p => p.status === 'pending');
  const completedItems = monthPlanned.filter(p => p.status === 'completed');
  const skippedItems = monthPlanned.filter(p => p.status === 'skipped');

  const totalPlanned = pendingItems.reduce((sum, p) => sum + (p.type === 'expense' ? p.amount : 0), 0);
  const totalCompleted = completedItems.reduce((sum, p) => sum + (p.type === 'expense' ? p.amount : 0), 0);

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'text-red-400 bg-red-500/10';
      case 'medium': return 'text-yellow-400 bg-yellow-500/10';
      case 'low': return 'text-green-400 bg-green-500/10';
      default: return 'text-gray-400 bg-gray-500/10';
    }
  };

  const getStatusIcon = (status: PlannedTransactionStatus) => {
    switch (status) {
      case 'completed': return <CheckCircle className="w-4 h-4 text-green-400" />;
      case 'skipped': return <XCircle className="w-4 h-4 text-gray-400" />;
      default: return <Clock className="w-4 h-4 text-amber-400" />;
    }
  };

  if (loading && planned.length === 0) {
    return (
      <div className="glass-card p-6">
        <div className="animate-pulse flex items-center gap-3">
          <div className="w-6 h-6 bg-amber-500/20 rounded"></div>
          <div className="h-4 bg-amber-500/20 rounded w-32"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center">
            <Calendar className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Planned Payments</h3>
            <p className="text-sm text-white/60">Your financial todos</p>
          </div>
        </div>
        <button
          onClick={() => {
            setShowAddForm(!showAddForm);
            setEditingId(null);
            setFormData({
              title: '',
              amount: '',
              type: 'expense',
              category: 'other',
              accountId: '',
              dueDate: format(new Date(), 'yyyy-MM-dd'),
              notes: '',
              priority: 'medium',
              isRecurring: false,
              recurringFrequency: 'monthly',
            });
          }}
          className="flex items-center gap-2 px-3 py-2 bg-amber-600 hover:bg-amber-700 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add
        </button>
      </div>

      {/* Month Navigator */}
      <div className="flex items-center justify-between mb-4 p-3 bg-amber-900/10 rounded-lg">
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, -1))}
          className="p-1 hover:bg-amber-500/10 rounded"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <span className="font-medium">{format(currentMonth, 'MMMM yyyy')}</span>
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
          className="p-1 hover:bg-amber-500/10 rounded"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="p-3 bg-amber-900/10 rounded-lg">
          <p className="text-xs text-white/60 mb-1">Pending</p>
          <p className="text-lg font-semibold text-yellow-400">
            ${totalPlanned.toLocaleString()}
          </p>
          <p className="text-xs text-white/40">{pendingItems.length} items</p>
        </div>
        <div className="p-3 bg-amber-900/10 rounded-lg">
          <p className="text-xs text-white/60 mb-1">Completed</p>
          <p className="text-lg font-semibold text-green-400">
            ${totalCompleted.toLocaleString()}
          </p>
          <p className="text-xs text-white/40">{completedItems.length} items</p>
        </div>
      </div>

      {/* Add/Edit Form */}
      {showAddForm && (
        <form onSubmit={handleSubmit} className="mb-4 p-4 bg-amber-900/10 rounded-lg border border-amber-500/20">
          <h4 className="font-medium mb-3">{editingId ? 'Edit' : 'Add'} Planned Payment</h4>
          
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs text-white/60 mb-1">Title</label>
              <input
                type="text"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                className="w-full px-3 py-2 bg-amber-900/20 border border-amber-500/30 rounded-lg text-sm"
                placeholder="Rent, Insurance..."
                required
              />
            </div>
            <div>
              <label className="block text-xs text-white/60 mb-1">Amount</label>
              <input
                type="number"
                value={formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                className="w-full px-3 py-2 bg-amber-900/20 border border-amber-500/30 rounded-lg text-sm"
                placeholder="0.00"
                step="0.01"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs text-white/60 mb-1">Type</label>
              <select
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value as 'expense' | 'income' })}
                className="w-full px-3 py-2 bg-amber-900/20 border border-amber-500/30 rounded-lg text-sm"
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-white/60 mb-1">Category</label>
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value as ExpenseCategory })}
                className="w-full px-3 py-2 bg-amber-900/20 border border-amber-500/30 rounded-lg text-sm"
              >
                {EXPENSE_CATEGORIES.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.icon} {cat.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs text-white/60 mb-1">Due Date</label>
              <input
                type="date"
                value={formData.dueDate}
                onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })}
                className="w-full px-3 py-2 bg-amber-900/20 border border-amber-500/30 rounded-lg text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-white/60 mb-1">Priority</label>
              <select
                value={formData.priority}
                onChange={(e) => setFormData({ ...formData, priority: e.target.value as 'high' | 'medium' | 'low' })}
                className="w-full px-3 py-2 bg-amber-900/20 border border-amber-500/30 rounded-lg text-sm"
              >
                <option value="high">🔴 High</option>
                <option value="medium">🟡 Medium</option>
                <option value="low">🟢 Low</option>
              </select>
            </div>
          </div>

          {profile?.paymentAccounts && profile.paymentAccounts.length > 0 && (
            <div className="mb-3">
              <label className="block text-xs text-white/60 mb-1">Account (optional)</label>
              <select
                value={formData.accountId}
                onChange={(e) => setFormData({ ...formData, accountId: e.target.value })}
                className="w-full px-3 py-2 bg-amber-900/20 border border-amber-500/30 rounded-lg text-sm"
              >
                <option value="">Select account...</option>
                {profile.paymentAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="mb-3">
            <label className="block text-xs text-white/60 mb-1">Notes (optional)</label>
            <input
              type="text"
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              className="w-full px-3 py-2 bg-amber-900/20 border border-amber-500/30 rounded-lg text-sm"
              placeholder="Additional notes..."
            />
          </div>

          <div className="flex items-center gap-3 mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.isRecurring}
                onChange={(e) => setFormData({ ...formData, isRecurring: e.target.checked })}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm">Recurring</span>
            </label>
            {formData.isRecurring && (
              <select
                value={formData.recurringFrequency}
                onChange={(e) => setFormData({ ...formData, recurringFrequency: e.target.value as 'weekly' | 'monthly' | 'yearly' })}
                className="px-2 py-1 bg-amber-900/20 border border-amber-500/30 rounded text-sm"
              >
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              className="flex-1 py-2 bg-amber-600 hover:bg-amber-700 rounded-lg text-sm font-medium transition-colors"
            >
              {editingId ? 'Update' : 'Add'} Payment
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                setEditingId(null);
              }}
              className="px-4 py-2 bg-amber-900/20 hover:bg-amber-500/20 rounded-lg text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Pending Items */}
      {pendingItems.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-white/60 mb-2 flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Pending ({pendingItems.length})
          </h4>
          <div className="space-y-2">
            {pendingItems.map((item) => (
              <div
                key={item.id}
                className="p-3 bg-amber-900/10 rounded-lg border border-amber-500/20 hover:border-amber-500/40 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-0.5 rounded text-xs ${getPriorityColor(item.priority)}`}>
                        {item.priority}
                      </span>
                      {item.isRecurring && (
                        <RefreshCw className="w-3 h-3 text-amber-400" />
                      )}
                    </div>
                    <h5 className="font-medium">{item.title}</h5>
                    <div className="flex items-center gap-3 text-sm text-white/60 mt-1">
                      <span className={item.type === 'expense' ? 'text-red-400' : 'text-green-400'}>
                        {item.type === 'expense' ? '-' : '+'}${item.amount.toLocaleString()}
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {format(parseISO(item.dueDate), 'MMM d')}
                      </span>
                    </div>
                    {item.notes && (
                      <p className="text-xs text-white/40 mt-1">{item.notes}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <button
                      onClick={() => handleComplete(item, true)}
                      className="p-1.5 bg-green-500/20 hover:bg-green-500/30 rounded text-green-400"
                      title="Complete & create transaction"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleSkip(item.id)}
                      className="p-1.5 bg-gray-500/20 hover:bg-gray-500/30 rounded text-gray-400"
                      title="Skip"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleEdit(item)}
                      className="p-1.5 bg-amber-500/20 hover:bg-amber-500/30 rounded text-amber-400"
                      title="Edit"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="p-1.5 bg-red-500/20 hover:bg-red-500/30 rounded text-red-400"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Completed Items */}
      {completedItems.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-white/60 mb-2 flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-400" />
            Completed ({completedItems.length})
          </h4>
          <div className="space-y-2">
            {completedItems.map((item) => (
              <div
                key={item.id}
                className="p-3 bg-amber-900/10 rounded-lg border border-green-500/20 opacity-70"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h5 className="font-medium line-through text-white/60">{item.title}</h5>
                    <div className="flex items-center gap-3 text-sm text-white/40 mt-1">
                      <span>${item.amount.toLocaleString()}</span>
                      <span>{format(parseISO(item.dueDate), 'MMM d')}</span>
                    </div>
                  </div>
                  <CheckCircle className="w-5 h-5 text-green-400" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Skipped Items */}
      {skippedItems.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-white/60 mb-2 flex items-center gap-2">
            <XCircle className="w-4 h-4 text-gray-400" />
            Skipped ({skippedItems.length})
          </h4>
          <div className="space-y-2">
            {skippedItems.map((item) => (
              <div
                key={item.id}
                className="p-3 bg-amber-900/10 rounded-lg border border-amber-500/10 opacity-50"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h5 className="font-medium line-through text-white/40">{item.title}</h5>
                    <div className="flex items-center gap-3 text-sm text-white/30 mt-1">
                      <span>${item.amount.toLocaleString()}</span>
                      <span>{format(parseISO(item.dueDate), 'MMM d')}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => updatePlannedTransaction(user!.id, item.id, { status: 'pending' }).then(fetchPlanned)}
                    className="text-xs text-amber-400 hover:underline"
                  >
                    Restore
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {monthPlanned.length === 0 && (
        <div className="text-center py-8 text-white/40">
          <Calendar className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>No planned payments for {format(currentMonth, 'MMMM yyyy')}</p>
          <button
            onClick={() => setShowAddForm(true)}
            className="mt-3 text-amber-400 hover:underline text-sm"
          >
            Add your first planned payment
          </button>
        </div>
      )}
    </div>
  );
}
