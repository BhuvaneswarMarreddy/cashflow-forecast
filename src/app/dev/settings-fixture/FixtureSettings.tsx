'use client';

/** Renders the REAL Settings screen against fixtures. See _fixture/FixtureShell. */
import React from 'react';
import SettingsPage from '@/app/settings/page';
import FixtureShell from '../_fixture/FixtureShell';

export default function FixtureSettings() {
  return (
    <FixtureShell name="settings">
      <SettingsPage />
    </FixtureShell>
  );
}
