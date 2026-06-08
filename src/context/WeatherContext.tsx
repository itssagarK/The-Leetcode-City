'use client';

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { useWeatherMap } from '@/hooks/useWeatherMap'; // We will import our API hook

interface WeatherContextType {
  isRaining: boolean;
  setIsRaining: (raining: boolean) => void;
  isLoading: boolean;
  error: string | null;
}

const WeatherContext = createContext<WeatherContextType | undefined>(undefined);

export function WeatherProvider({ children }: { children: React.ReactNode }) {
  const { isRaining: apiIsRaining, isLoading, error } = useWeatherMap();
  const [isRaining, setIsRaining] = useState(false);
  const isManuallySet = useRef(false);

  const handleSetIsRaining = (raining: boolean) => {
    isManuallySet.current = true;
    setIsRaining(raining);
  };

  useEffect(() => {
    if (!isLoading && !error && !isManuallySet.current) {
      setIsRaining(apiIsRaining);
    }
  }, [apiIsRaining, isLoading, error]);

  return (
    <WeatherContext.Provider value={{ isRaining, setIsRaining: handleSetIsRaining, isLoading, error }}>
      {children}
    </WeatherContext.Provider>
  );
}

export function useWeather() {
  const context = useContext(WeatherContext);
  if (context === undefined) {
    throw new Error('useWeather must be used within a WeatherProvider');
  }
  return context;
}