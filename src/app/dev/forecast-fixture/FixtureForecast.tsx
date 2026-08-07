'use client';

/** Renders the REAL Forecast screen against fixtures. See _fixture/FixtureShell. */
import React from 'react';
import ForecastPage from '@/app/forecast/page';
import FixtureShell from '../_fixture/FixtureShell';

export default function FixtureForecast() {
  return (
    <FixtureShell name="forecast">
      <ForecastPage />
    </FixtureShell>
  );
}
