'use client';

/** Renders the REAL Flow screen against fixtures. See _fixture/FixtureShell. */
import React from 'react';
import FlowPage from '@/app/flow/page';
import FixtureShell from '../_fixture/FixtureShell';

export default function FixtureFlow() {
  return (
    <FixtureShell name="flow">
      <FlowPage />
    </FixtureShell>
  );
}
