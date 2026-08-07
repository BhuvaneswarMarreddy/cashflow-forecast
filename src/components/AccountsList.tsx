'use client';
import React from 'react';
import {
  DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter, DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, sortableKeyboardCoordinates, arrayMove,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { PaymentAccount } from '@/types';

function Row({ account, index, count, render }: {
  account: PaymentAccount; index: number; count: number; render: (a: PaymentAccount) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: account.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="flex items-stretch gap-2"
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${account.name}, currently ${index + 1} of ${count}`}
        className="flex items-center px-1 text-[var(--foreground-muted)] hover:text-[var(--foreground)] cursor-grab active:cursor-grabbing rounded-control"
        style={{ touchAction: 'none', WebkitTouchCallout: 'none', userSelect: 'none' }}
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <div className="flex-1 min-w-0">{render(account)}</div>
    </div>
  );
}

export default function AccountsList({ accounts, onReorder, renderRow }: {
  accounts: PaymentAccount[];
  onReorder: (orderedIds: string[]) => void;
  renderRow: (a: PaymentAccount) => React.ReactNode;
}) {
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (accounts.length < 2) {
    return <div className="space-y-3">{accounts.map((a) => <div key={a.id}>{renderRow(a)}</div>)}</div>;
  }

  const ids = accounts.map((a) => a.id);
  const active = accounts.find((a) => a.id === activeId) || null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragEnd={(e) => {
        setActiveId(null);
        const { active: act, over } = e;
        if (over && act.id !== over.id) {
          onReorder(arrayMove(ids, ids.indexOf(String(act.id)), ids.indexOf(String(over.id))));
        }
      }}
      onDragCancel={() => setActiveId(null)}
      accessibility={{
        announcements: {
          onDragStart: ({ active: a }) => `Picked up ${a.id}`,
          onDragOver: ({ active: a, over }) => (over ? `${a.id} moved over ${over.id}` : ''),
          onDragEnd: ({ active: a, over }) => (over ? `Dropped ${a.id} onto ${over.id}` : `Dropped ${a.id}`),
          onDragCancel: ({ active: a }) => `Reorder of ${a.id} cancelled`,
        },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="space-y-3">
          {accounts.map((a, i) => (
            <Row key={a.id} account={a} index={i} count={accounts.length} render={renderRow} />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>{active ? <div className="opacity-90 scale-[1.02]">{renderRow(active)}</div> : null}</DragOverlay>
    </DndContext>
  );
}
