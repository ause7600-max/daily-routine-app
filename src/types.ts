import { format } from 'date-fns';

export type RepeatDay = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface Task {
  id: string;
  name: string;
  time: string; // "HH:mm"
  repeat: RepeatDay[] | 'daily' | 'once';
  completedDates: string[]; // ISO date strings (YYYY-MM-DD)
  isActive: boolean;
  lastNotified?: string; // ISO date string
  reminderCount?: number; // How many reminders have been sent for today's instance
  lastReminderTime?: string; // ISO date string
  snoozedUntil?: string; // ISO date string
}

export interface UserStats {
  streak: number;
  totalCompleted: number;
  lastCompletedDate?: string;
}

export interface AppSettings {
  reminderDelayMinutes: number;
  maxReminders: number;
  snoozeDurationMinutes: number;
  notificationsEnabled: boolean;
}

export interface DailyProgress {
  date: string; // YYYY-MM-DD
  completed: number;
  total: number;
  percentage: number;
}
