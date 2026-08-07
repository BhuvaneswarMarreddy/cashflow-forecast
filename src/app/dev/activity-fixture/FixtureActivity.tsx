'use client';

/** Renders the REAL Activity screen against fixtures. See _fixture/FixtureShell. */
import React from 'react';
import HistoryPage from '@/app/history/page';
import FixtureShell from '../_fixture/FixtureShell';

export default function FixtureActivity() {
  return (
    <FixtureShell name="activity">
      <HistoryPage />
    </FixtureShell>
  );
}
