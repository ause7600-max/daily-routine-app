/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Daily Routine Tracker App
 * Last updated: Ready for GitHub export
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { 
  Plus, 
  Clock, 
  CheckCircle2, 
  Circle, 
  Trash2, 
  Edit2, 
  Bell, 
  BellOff, 
  Calendar, 
  Trophy, 
  Flame,
  X,
  ChevronRight,
  Settings,
  Moon,
  Sun,
  Volume2,
  VolumeX,
  Download
} from 'lucide-react';
import { format, isToday, parseISO, startOfToday, addDays, isSameDay } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import confetti from 'canvas-confetti';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { Task, RepeatDay, UserStats, AppSettings, DailyProgress } from './types';
import { useLocalStorage } from './hooks/useLocalStorage';

import { useTheme } from './context/ThemeContext';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const DAYS: RepeatDay[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function App() {
  const { isDarkMode, toggleTheme } = useTheme();
  const [tasks, setTasks] = useLocalStorage<Task[]>('routine-tasks', []);
  const [stats, setStats] = useLocalStorage<UserStats>('routine-stats', {
    streak: 0,
    totalCompleted: 0
  });
  const [appSettings, setAppSettings] = useLocalStorage<AppSettings>('routine-settings', {
    reminderDelayMinutes: 15,
    maxReminders: 2,
    snoozeDurationMinutes: 10,
    notificationsEnabled: true
  });
  const [history, setHistory] = useLocalStorage<DailyProgress[]>('routine-history', []);
  const [soundEnabled, setSoundEnabled] = useLocalStorage('sound-enabled', true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [activeAlarm, setActiveAlarm] = useState<Task | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    'Notification' in window ? Notification.permission : 'default'
  );
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const schedulerRef = useRef<NodeJS.Timeout | null>(null);

  // PWA Install Prompt Listener
  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  };

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) {
      console.warn('[Notification] Browser does not support notifications');
      return;
    }
    try {
      console.log('[Notification] Requesting permission...');
      const permission = await Notification.requestPermission();
      console.log(`[Notification] Permission result: ${permission}`);
      setNotificationPermission(permission);
    } catch (error) {
      console.error('[Notification] Error requesting permission:', error);
    }
  };

  const showNotification = useCallback((title: string, body: string, taskId: string) => {
    if (!appSettings.notificationsEnabled) {
      console.log('[Notification] Notifications are disabled in app settings.');
      return;
    }

    console.log(`[Notification] Triggered: ${title} - ${body}`);
    console.log(`[Notification] Current permission: ${Notification.permission}`);

    if (Notification.permission === 'granted') {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(registration => {
          console.log('[Notification] Service worker ready, showing notification...');
          registration.showNotification(title, {
            body,
            icon: "/favicon.ico",
            tag: `task-${taskId}`,
            data: { taskId },
            actions: [
              { action: 'mark-done', title: '✅ Mark as Done' },
              { action: 'snooze', title: '⏰ Snooze (10m)' }
            ]
          } as any).catch(err => console.error('[Notification] Error showing via SW:', err));
        });
      } else {
        console.log('[Notification] No service worker, using fallback Notification API');
        try {
          new Notification(title, { body, icon: "/favicon.ico" });
        } catch (e) {
          console.error('[Notification] Fallback failed (likely mobile Chrome requires SW):', e);
        }
      }
    } else {
      console.warn('[Notification] Permission not granted, cannot show notification.');
    }
  }, []);

  // Register Service Worker and handle messages
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      console.log('[SW] Attempting to register service worker...');
      navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('[SW] Registered successfully with scope:', reg.scope))
        .catch(err => console.error('[SW] Registration Failed:', err));

      const handleMessage = (event: MessageEvent) => {
        console.log('[SW] Message received from service worker:', event.data);
        if (event.data.type === 'MARK_DONE') {
          toggleComplete(event.data.taskId);
        } else if (event.data.type === 'SNOOZE') {
          snoozeTask(event.data.taskId);
        }
      };

      navigator.serviceWorker.addEventListener('message', handleMessage);
      return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
    }
  }, []);

  // Initialize audio
  useEffect(() => {
    audioRef.current = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
    audioRef.current.loop = true;
  }, []);

  // Refactored Alarm Checker Logic
  const checkAlarms = useCallback(() => {
    const now = new Date();
    const currentTimeStr = format(now, 'HH:mm');
    const currentDay = format(now, 'EEE') as RepeatDay;
    const todayStr = format(now, 'yyyy-MM-dd');

    setTasks(prevTasks => {
      let updated = false;
      const newTasks = prevTasks.map(task => {
        if (!task.isActive) return task;

        const isCompletedToday = task.completedDates.includes(todayStr);
        if (isCompletedToday) return task;

        const isTodayTask = 
          task.repeat === 'daily' || 
          (Array.isArray(task.repeat) && task.repeat.includes(currentDay)) ||
          (task.repeat === 'once' && !task.completedDates.some(d => isToday(parseISO(d))));

        if (!isTodayTask) return task;

        // 1. Initial Alarm
        if (task.time === currentTimeStr) {
          const lastNotified = task.lastNotified ? parseISO(task.lastNotified) : null;
          const isRecentlyNotified = lastNotified && (now.getTime() - lastNotified.getTime() < 60000);

          if (!isRecentlyNotified && !activeAlarm) {
            triggerAlarm(task);
            updated = true;
            return { ...task, lastNotified: new Date().toISOString() };
          }
        }

        // 2. Snooze Reminder
        if (task.snoozedUntil) {
          const snoozeDate = parseISO(task.snoozedUntil);
          if (now >= snoozeDate) {
            triggerAlarm(task, "Snooze Reminder");
            updated = true;
            return { ...task, snoozedUntil: undefined, lastNotified: new Date().toISOString() };
          }
        }

        // 3. Smart Missed Task Reminder
        const [hours, minutes] = task.time.split(':').map(Number);
        const taskTime = new Date();
        taskTime.setHours(hours, minutes, 0, 0);

        const diffMinutes = (now.getTime() - taskTime.getTime()) / 60000;
        const currentReminderCount = task.reminderCount || 0;

        if (diffMinutes >= appSettings.reminderDelayMinutes * (currentReminderCount + 1) && 
            currentReminderCount < appSettings.maxReminders) {
          
          const lastReminder = task.lastReminderTime ? parseISO(task.lastReminderTime) : null;
          const isRecentlyReminded = lastReminder && (now.getTime() - lastReminder.getTime() < 60000);

          if (!isRecentlyReminded) {
            const messages = [
              "You missed your task 😤 Try completing it now!🤕",
              "Don't give up! You still have time 💪",
              "Consistency is key! Let's get it done 🚀"
            ];
            const message = messages[currentReminderCount] || messages[messages.length - 1];
            triggerSmartReminder(task, message, currentReminderCount + 1);
            updated = true;
            return { 
              ...task, 
              reminderCount: currentReminderCount + 1, 
              lastReminderTime: new Date().toISOString() 
            };
          }
        }

        return task;
      });

      return updated ? newTasks : prevTasks;
    });
  }, [activeAlarm, appSettings, soundEnabled]);

  // Fallback Checker (runs every minute)
  useEffect(() => {
    const interval = setInterval(checkAlarms, 60000);
    return () => clearInterval(interval);
  }, [checkAlarms]);

  // Precise Scheduler (Hybrid Approach)
  useEffect(() => {
    const scheduleNext = () => {
      if (schedulerRef.current) clearTimeout(schedulerRef.current);

      const now = new Date();
      const todayStr = format(now, 'yyyy-MM-dd');
      const currentDay = format(now, 'EEE') as RepeatDay;

      let nextTriggerTime: number | null = null;

      tasks.forEach(task => {
        if (!task.isActive) return;
        const isCompletedToday = task.completedDates.includes(todayStr);
        if (isCompletedToday) return;

        const isTodayTask = 
          task.repeat === 'daily' || 
          (Array.isArray(task.repeat) && task.repeat.includes(currentDay)) ||
          (task.repeat === 'once' && !task.completedDates.some(d => isToday(parseISO(d))));

        if (!isTodayTask) return;

        // 1. Initial Alarm Time
        const [hours, minutes] = task.time.split(':').map(Number);
        const taskTime = new Date();
        taskTime.setHours(hours, minutes, 0, 0);

        if (taskTime > now) {
          if (nextTriggerTime === null || taskTime.getTime() < nextTriggerTime) {
            nextTriggerTime = taskTime.getTime();
          }
        }

        // 2. Snooze
        if (task.snoozedUntil) {
          const snoozeDate = parseISO(task.snoozedUntil).getTime();
          if (snoozeDate > now.getTime()) {
            if (nextTriggerTime === null || snoozeDate < nextTriggerTime) {
              nextTriggerTime = snoozeDate;
            }
          }
        }

        // 3. Smart Reminders
        const currentReminderCount = task.reminderCount || 0;
        if (currentReminderCount < appSettings.maxReminders) {
           const nextSmartTime = taskTime.getTime() + (appSettings.reminderDelayMinutes * (currentReminderCount + 1) * 60000);
           if (nextSmartTime > now.getTime()) {
             if (nextTriggerTime === null || nextSmartTime < nextTriggerTime) {
               nextTriggerTime = nextSmartTime;
             }
           }
        }
      });

      if (nextTriggerTime) {
        const delay = Math.max(0, nextTriggerTime - now.getTime());
        // Use a small buffer to ensure we land exactly on or after the target time
        schedulerRef.current = setTimeout(() => {
          checkAlarms();
        }, delay + 500); 
      }
    };

    scheduleNext();
    return () => {
      if (schedulerRef.current) clearTimeout(schedulerRef.current);
    };
  }, [tasks, appSettings, checkAlarms]);

  const triggerAlarm = useCallback((task: Task, title: string = "Routine Reminder") => {
    setActiveAlarm(task);
    if (soundEnabled && audioRef.current) {
      audioRef.current.play().catch(e => console.error("Audio play failed", e));
    }
    
    showNotification(title, `It's time for: ${task.name}`, task.id);
  }, [soundEnabled, showNotification]);

  const triggerSmartReminder = useCallback((task: Task, message: string, count: number) => {
    showNotification("Missed Task!", message, task.id);
  }, [showNotification]);

  const snoozeTask = (taskId: string) => {
    const snoozeTime = new Date(Date.now() + appSettings.snoozeDurationMinutes * 60000).toISOString();
    setTasks(prev => prev.map(t => 
      t.id === taskId ? { ...t, snoozedUntil: snoozeTime } : t
    ));
    stopAlarm();
  };

  const stopAlarm = () => {
    setActiveAlarm(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };

  const handleAddTask = (taskData: Omit<Task, 'id' | 'completedDates' | 'isActive'>) => {
    const newTask: Task = {
      ...taskData,
      id: crypto.randomUUID(),
      completedDates: [],
      isActive: true
    };
    setTasks([...tasks, newTask]);
    setShowAddModal(false);
  };

  const handleUpdateTask = (taskData: Omit<Task, 'completedDates' | 'isActive'>) => {
    setTasks(prev => prev.map(t => 
      t.id === taskData.id ? { ...t, ...taskData } : t
    ));
    setEditingTask(null);
  };

  const toggleComplete = (taskId: string) => {
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    let wasCompleted = false;

    setTasks(prev => {
      const newTasks = prev.map(t => {
        if (t.id === taskId) {
          const isCompleted = t.completedDates.includes(todayStr);
          wasCompleted = !isCompleted;
          return {
            ...t,
            completedDates: isCompleted 
              ? t.completedDates.filter(d => d !== todayStr)
              : [...t.completedDates, todayStr]
          };
        }
        return t;
      });

      // Update history
      const currentDayTasks = newTasks.filter(task => {
        const currentDay = format(new Date(), 'EEE') as RepeatDay;
        return task.repeat === 'daily' || 
               (Array.isArray(task.repeat) && task.repeat.includes(currentDay)) ||
               task.repeat === 'once';
      });
      
      const completedCount = currentDayTasks.filter(t => t.completedDates.includes(todayStr)).length;
      const totalCount = currentDayTasks.length;
      const percentage = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

      setHistory(prevHistory => {
        const filtered = prevHistory.filter(h => h.date !== todayStr);
        const newHistory = [...filtered, {
          date: todayStr,
          completed: completedCount,
          total: totalCount,
          percentage
        }].sort((a, b) => a.date.localeCompare(b.date));
        
        // Keep only last 14 days to be safe
        return newHistory.slice(-14);
      });

      return newTasks;
    });

    if (wasCompleted) {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#6367FF', '#8494FF', '#C9BEFF']
      });

      // Update stats
      setStats(prev => {
        const newTotal = prev.totalCompleted + 1;
        const lastDate = prev.lastCompletedDate ? parseISO(prev.lastCompletedDate) : null;
        const yesterday = addDays(startOfToday(), -1);
        
        let newStreak = prev.streak;
        if (!lastDate || isSameDay(lastDate, yesterday)) {
          newStreak += 1;
        } else if (!isToday(lastDate)) {
          newStreak = 1;
        }

        return {
          ...prev,
          totalCompleted: newTotal,
          streak: newStreak,
          lastCompletedDate: new Date().toISOString()
        };
      });
    }
  };

  const deleteTask = (id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const todayTasks = useMemo(() => {
    const currentDay = format(new Date(), 'EEE') as RepeatDay;
    return tasks.filter(task => {
      return task.repeat === 'daily' || 
             (Array.isArray(task.repeat) && task.repeat.includes(currentDay)) ||
             task.repeat === 'once';
    }).sort((a, b) => a.time.localeCompare(b.time));
  }, [tasks]);

  const progress = useMemo(() => {
    if (todayTasks.length === 0) return 0;
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const completedCount = todayTasks.filter(t => t.completedDates.includes(todayStr)).length;
    return Math.round((completedCount / todayTasks.length) * 100);
  }, [todayTasks]);

  const statsSummary = useMemo(() => {
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const completed = todayTasks.filter(t => t.completedDates.includes(todayStr)).length;
    const total = todayTasks.length;
    const remaining = total - completed;
    return { total, completed, remaining };
  }, [todayTasks]);

  const weeklyHistory = useMemo(() => {
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(startOfToday(), -i);
      const dateStr = format(date, 'yyyy-MM-dd');
      const dayName = format(date, 'EEE');
      const record = history.find(h => h.date === dateStr);
      return {
        date: dateStr,
        dayName,
        percentage: record ? record.percentage : 0,
        isToday: i === 0
      };
    }).reverse();
    return last7Days;
  }, [history]);

  // Request notification permission on mount if default (some browsers allow this, some require gesture)
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      console.log('[Notification] Initial permission is default, requesting...');
      Notification.requestPermission().then(perm => {
        console.log(`[Notification] Initial request result: ${perm}`);
        setNotificationPermission(perm);
      });
    }
  }, []);

  return (
    <div className="min-h-screen transition-colors duration-500">
      {/* Header */}
      <header className="sticky top-0 z-30 glass px-6 py-4 flex flex-col transition-colors duration-500">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-display font-bold tracking-tight bg-gradient-to-r from-brand-600 to-blue-500 bg-clip-text text-transparent">Routine</h1>
            <p className="text-xs text-app-text/60 font-semibold">{format(new Date(), 'EEEE, MMMM do')}</p>
          </div>
          <div className="flex items-center gap-3">
            {deferredPrompt && (
              <button 
                onClick={handleInstallClick}
                className="p-2.5 rounded-2xl bg-brand-600 text-white hover:bg-brand-700 transition-all active:scale-90 flex items-center gap-2 shadow-lg shadow-brand-500/20"
                title="Install App"
              >
                <Download size={18} />
              </button>
            )}
            <button 
              onClick={toggleTheme}
              className="p-2.5 rounded-2xl bg-app-text/5 text-app-text/70 hover:bg-app-text/10 transition-all active:scale-90"
            >
              {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button 
              onClick={() => setSoundEnabled(!soundEnabled)}
              className="p-2.5 rounded-2xl bg-app-text/5 text-app-text/70 hover:bg-app-text/10 transition-all active:scale-90"
            >
              {soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            <button 
              onClick={() => setShowSettingsModal(true)}
              className="p-2.5 rounded-2xl bg-app-text/5 text-app-text/70 hover:bg-app-text/10 transition-all active:scale-90"
            >
              <Settings size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-8 pb-32">
        {/* Stats Cards */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-5 rounded-[32px] bg-orange-50 dark:bg-orange-950/20 border border-orange-100 dark:border-orange-900/30"
          >
            <div className="flex items-center gap-2 text-orange-600 dark:text-orange-300 mb-1.5">
              <Flame size={16} />
              <span className="text-[10px] font-bold uppercase tracking-widest text-orange-500">Streak</span>
            </div>
            <div className="text-2xl font-display font-bold text-orange-600 dark:text-orange-400">{stats.streak} Days</div>
          </motion.div>
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="p-5 rounded-[32px] bg-brand-50 dark:bg-brand-950/20 border border-brand-100 dark:border-brand-900/30"
          >
            <div className="flex items-center gap-2 text-brand-600 dark:text-brand-300 mb-1.5">
              <Trophy size={16} />
              <span className="text-[10px] font-bold uppercase tracking-widest text-brand-500">Total</span>
            </div>
            <div className="text-2xl font-display font-bold text-brand-600 dark:text-brand-400">{stats.totalCompleted}</div>
          </motion.div>
        </div>

        {/* Task Stats Summary */}
        <div className="grid grid-cols-3 gap-3 mb-8">
          <div className="p-3 rounded-2xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-center">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Total</div>
            <div className="text-lg font-bold">{statsSummary.total}</div>
          </div>
          <div className="p-3 rounded-2xl bg-green-50 dark:bg-green-950/20 border border-green-100 dark:border-green-900/30 text-center">
            <div className="text-[10px] font-bold uppercase tracking-widest text-green-500 mb-1">Done</div>
            <div className="text-lg font-bold text-green-600 dark:text-green-400">{statsSummary.completed}</div>
          </div>
          <div className="p-3 rounded-2xl bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30 text-center">
            <div className="text-[10px] font-bold uppercase tracking-widest text-blue-500 mb-1">Left</div>
            <div className="text-lg font-bold text-blue-600 dark:text-blue-400">{statsSummary.remaining}</div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Today's Progress</h2>
              {progress === 100 && todayTasks.length > 0 && (
                <span className="px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400 text-[10px] font-bold rounded-full animate-bounce">
                  Perfect Day 🎉
                </span>
              )}
            </div>
            <span className="text-sm font-bold text-brand-600 dark:text-brand-400">{progress}%</span>
          </div>
          <div className="h-4 bg-slate-200 dark:bg-slate-900 rounded-full overflow-hidden border border-slate-300/30 dark:border-slate-800/50">
            <motion.div 
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              className="h-full bg-gradient-to-r from-brand-600 via-brand-400 to-blue-400"
            />
          </div>
        </div>

        {/* Weekly Progress Chart */}
        <div className="mb-10 p-6 rounded-[32px] bg-white dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800/50 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Weekly Activity</h2>
            <Calendar size={16} className="text-slate-400" />
          </div>
          <div className="flex items-end justify-between h-32 gap-2">
            {weeklyHistory.map((day, idx) => (
              <div key={idx} className="flex-1 flex flex-col items-center gap-2 group">
                <div className="relative w-full flex-1 flex items-end">
                  <motion.div 
                    initial={{ height: 0 }}
                    animate={{ height: `${day.percentage}%` }}
                    className={cn(
                      "w-full rounded-t-lg transition-all duration-300",
                      day.isToday 
                        ? "bg-brand-500 shadow-lg shadow-brand-500/20" 
                        : "bg-slate-200 dark:bg-slate-800 group-hover:bg-slate-300 dark:group-hover:bg-slate-700"
                    )}
                  />
                  {/* Tooltip */}
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                    {day.percentage}%
                  </div>
                </div>
                <span className={cn(
                  "text-[10px] font-bold uppercase tracking-tighter",
                  day.isToday ? "text-brand-600 dark:text-brand-400" : "text-slate-400"
                )}>
                  {day.dayName}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Task List */}
        <div className="space-y-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-display font-bold">Today's Routine</h2>
            <span className="text-xs font-medium px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-slate-500">
              {todayTasks.length} Tasks
            </span>
          </div>

          <AnimatePresence mode="popLayout">
            {todayTasks.length > 0 ? (
              todayTasks.map((task) => {
                const isCompleted = task.completedDates.includes(format(new Date(), 'yyyy-MM-dd'));
                return (
                  <motion.div
                    key={task.id}
                    layout
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className={cn(
                      "group p-5 rounded-[32px] transition-all duration-300 flex items-center gap-4",
                      isCompleted 
                        ? "bg-slate-100/50 dark:bg-slate-900/30 opacity-60" 
                        : "bg-white dark:bg-slate-900/50 backdrop-blur-sm shadow-sm border border-slate-100 dark:border-slate-800/50"
                    )}
                  >
                    <button 
                      onClick={() => toggleComplete(task.id)}
                      className={cn(
                        "transition-all active:scale-90",
                        isCompleted ? "text-brand-500" : "text-slate-300 dark:text-slate-700 hover:text-brand-400"
                      )}
                    >
                      {isCompleted ? <CheckCircle2 size={28} /> : <Circle size={28} />}
                    </button>
                    
                    <div className="flex-1 min-w-0">
                      <h3 className={cn(
                        "font-semibold truncate text-slate-900 dark:text-slate-100",
                        isCompleted && "line-through text-slate-500 dark:text-slate-500"
                      )}>
                        {task.name}
                      </h3>
                      <div className="flex items-center gap-3 mt-1">
                        <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                          <Clock size={12} />
                          {task.time}
                        </div>
                        {task.snoozedUntil && (
                          <div className="flex items-center gap-1 text-[10px] font-bold text-orange-500 dark:text-orange-400 uppercase tracking-widest">
                            <Bell size={10} className="animate-pulse" />
                            Snoozed
                          </div>
                        )}
                        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">
                          {Array.isArray(task.repeat) ? task.repeat.join(', ') : task.repeat}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button 
                        onClick={() => setEditingTask(task)}
                        className="p-2 text-slate-400 hover:text-brand-500 transition-colors"
                      >
                        <Edit2 size={16} />
                      </button>
                      <button 
                        onClick={() => deleteTask(task.id)}
                        className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </motion.div>
                );
              })
            ) : (
              <div className="text-center py-16">
                <div className="w-20 h-20 bg-slate-100 dark:bg-slate-900 rounded-[32px] flex items-center justify-center mx-auto mb-6 text-slate-400 dark:text-slate-600 border border-slate-200 dark:border-slate-800">
                  <Calendar size={32} />
                </div>
                <p className="text-slate-500 dark:text-slate-400 font-semibold">No tasks for today.</p>
                <button 
                  onClick={() => setShowAddModal(true)}
                  className="mt-4 text-brand-600 dark:text-brand-400 font-bold text-sm hover:underline"
                >
                  Add your first task
                </button>
              </div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Floating Action Button */}
      <button 
        onClick={() => setShowAddModal(true)}
        className="fixed bottom-8 right-8 w-16 h-16 bg-gradient-to-br from-white to-blue-500 text-blue-600 rounded-full shadow-lg shadow-blue-200/50 flex items-center justify-center hover:scale-110 active:scale-95 transition-transform z-40 border border-blue-100"
      >
        <Plus size={32} />
      </button>

      {/* Add/Edit Modal */}
      <AnimatePresence>
        {(showAddModal || editingTask) && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => { setShowAddModal(false); setEditingTask(null); }}
              className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="relative w-full max-w-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-t-[40px] sm:rounded-[40px] p-8 shadow-2xl border-t border-slate-200 dark:border-slate-800"
            >
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-2xl font-display font-bold dark:text-white">
                  {editingTask ? 'Edit Task' : 'New Task'}
                </h2>
                <button 
                  onClick={() => { setShowAddModal(false); setEditingTask(null); }}
                  className="p-2.5 bg-slate-100 dark:bg-slate-900 rounded-2xl text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <TaskForm 
                initialData={editingTask || undefined}
                onSubmit={editingTask ? handleUpdateTask : handleAddTask}
                onCancel={() => { setShowAddModal(false); setEditingTask(null); }}
              />
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettingsModal && (
          <SettingsModal 
            settings={appSettings}
            onUpdate={setAppSettings}
            onClose={() => setShowSettingsModal(false)}
            notificationPermission={notificationPermission}
            onRequestPermission={requestNotificationPermission}
          />
        )}
      </AnimatePresence>

      {/* Alarm Overlay */}
      <AnimatePresence>
        {activeAlarm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-950/90 backdrop-blur-2xl"
            />
            <div className="absolute inset-0 bg-gradient-to-br from-brand-600/20 to-blue-600/20 opacity-50" />
            <motion.div 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              className="relative w-full max-w-sm text-center text-white"
            >
              <div className="w-24 h-24 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-8 animate-pulse">
                <Bell size={48} className="animate-bounce" />
              </div>
              <h2 className="text-sm font-bold uppercase tracking-[0.2em] mb-2 opacity-80">Routine Alert</h2>
              <h3 className="text-4xl font-display font-bold mb-12">{activeAlarm.name}</h3>
              
              <div className="space-y-4">
                <button 
                  onClick={stopAlarm}
                  className="w-full py-5 bg-white text-brand-700 rounded-[32px] font-bold text-xl shadow-2xl hover:scale-105 active:scale-95 transition-transform"
                >
                  Dismiss
                </button>
                <button 
                  onClick={() => snoozeTask(activeAlarm.id)}
                  className="w-full py-5 bg-white/10 text-white rounded-[32px] font-bold hover:bg-white/20 transition-all active:scale-95 border border-white/10"
                >
                  Snooze 10m
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface TaskFormProps {
  initialData?: Task;
  onSubmit: (data: any) => void;
  onCancel: () => void;
}

function TaskForm({ initialData, onSubmit, onCancel }: TaskFormProps) {
  const [name, setName] = useState(initialData?.name || '');
  const [time, setTime] = useState(initialData?.time || format(new Date(), 'HH:mm'));
  const [repeat, setRepeat] = useState<RepeatDay[] | 'daily' | 'once'>(initialData?.repeat || 'daily');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      id: initialData?.id,
      name,
      time,
      repeat
    });
  };

  const toggleDay = (day: RepeatDay) => {
    if (repeat === 'daily' || repeat === 'once') {
      setRepeat([day]);
    } else {
      const newDays = repeat.includes(day)
        ? repeat.filter(d => d !== day)
        : [...repeat, day];
      setRepeat(newDays.length === 0 ? 'once' : newDays);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-2.5 ml-1">Task Name</label>
        <input 
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Morning Yoga"
          className="w-full p-5 bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-[24px] border border-transparent focus:border-brand-500/50 focus:ring-4 focus:ring-brand-500/10 transition-all outline-none placeholder:text-slate-400 dark:placeholder:text-slate-600"
        />
      </div>

      <div>
        <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-2.5 ml-1">Time</label>
        <input 
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="w-full p-5 bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-[24px] border border-transparent focus:border-brand-500/50 focus:ring-4 focus:ring-brand-500/10 transition-all outline-none"
        />
      </div>

      <div>
        <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-3.5 ml-1">Repeat</label>
        <div className="flex flex-wrap gap-2.5">
          <button 
            type="button"
            onClick={() => setRepeat('daily')}
            className={cn(
              "px-6 py-3 rounded-2xl text-sm font-bold transition-all active:scale-95",
              repeat === 'daily' 
                ? "bg-gradient-to-r from-brand-600 to-blue-500 text-white shadow-lg shadow-brand-500/20" 
                : "bg-slate-100 dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800"
            )}
          >
            Daily
          </button>
          <button 
            type="button"
            onClick={() => setRepeat('once')}
            className={cn(
              "px-6 py-3 rounded-2xl text-sm font-bold transition-all active:scale-95",
              repeat === 'once' 
                ? "bg-gradient-to-r from-brand-600 to-blue-500 text-white shadow-lg shadow-brand-500/20" 
                : "bg-slate-100 dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800"
            )}
          >
            Once
          </button>
          <div className="w-full flex gap-1.5 mt-2">
            {DAYS.map(day => (
              <button
                key={day}
                type="button"
                onClick={() => toggleDay(day)}
                className={cn(
                  "flex-1 py-3 rounded-xl text-[10px] font-bold transition-all active:scale-90",
                  Array.isArray(repeat) && repeat.includes(day)
                    ? "bg-brand-100 dark:bg-brand-900/50 text-brand-600 dark:text-brand-300 border border-brand-200 dark:border-brand-800"
                    : "bg-slate-50 dark:bg-slate-900/30 text-slate-400 dark:text-slate-600 border border-transparent"
                )}
              >
                {day}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="pt-4">
        <button 
          type="submit"
          className="w-full py-5 bg-gradient-to-r from-black to-blue-600 text-white rounded-[24px] font-bold text-lg shadow-xl shadow-blue-900/20 hover:opacity-90 transition-all active:scale-[0.98] border border-slate-800/50"
        >
          {initialData ? 'Save Changes' : 'Create Task'}
        </button>
      </div>
    </form>
  );
}

interface SettingsModalProps {
  settings: AppSettings;
  onUpdate: (settings: AppSettings) => void;
  onClose: () => void;
  notificationPermission: NotificationPermission;
  onRequestPermission: () => Promise<void>;
}

function SettingsModal({ settings, onUpdate, onClose, notificationPermission, onRequestPermission }: SettingsModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
      />
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="relative w-full max-w-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-[40px] p-8 shadow-2xl border border-slate-200 dark:border-slate-800 overflow-y-auto max-h-[90vh]"
      >
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl font-display font-bold">App Settings</h2>
          <button 
            onClick={onClose}
            className="p-2.5 bg-slate-100 dark:bg-slate-900 rounded-2xl text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-6">
          {/* Notification Toggle */}
          <div className="p-5 rounded-[24px] bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "p-2 rounded-xl",
                  settings.notificationsEnabled ? "bg-brand-100 text-brand-600 dark:bg-brand-900/30 dark:text-brand-400" : "bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500"
                )}>
                  <Bell size={18} />
                </div>
                <div>
                  <div className="text-sm font-bold">Notifications</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">Alerts for tasks and reminders</div>
                </div>
              </div>
              <button 
                onClick={() => {
                  const newState = !settings.notificationsEnabled;
                  onUpdate({ ...settings, notificationsEnabled: newState });
                  if (newState && notificationPermission === 'default') {
                    onRequestPermission();
                  }
                }}
                className={cn(
                  "w-12 h-6 rounded-full transition-colors relative",
                  settings.notificationsEnabled ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-700"
                )}
              >
                <motion.div 
                  animate={{ x: settings.notificationsEnabled ? 26 : 2 }}
                  className="absolute top-1 left-0 w-4 h-4 bg-white rounded-full shadow-sm"
                />
              </button>
            </div>

            {settings.notificationsEnabled && (
              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Status:</span>
                  <span className={cn(
                    "text-[10px] font-bold px-2 py-0.5 rounded-full",
                    notificationPermission === 'granted' ? "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400" : "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                  )}>
                    {notificationPermission === 'granted' ? 'Allowed ✅' : 'Blocked ❌'}
                  </span>
                </div>
                {notificationPermission === 'denied' && (
                  <button 
                    onClick={() => window.alert("To enable notifications, please open your browser settings and allow notifications for this site.")}
                    className="text-[10px] font-bold text-brand-600 dark:text-brand-400 hover:underline"
                  >
                    How to fix?
                  </button>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-2.5 ml-1">Reminder Delay (Minutes)</label>
            <select 
              value={settings.reminderDelayMinutes}
              onChange={(e) => onUpdate({ ...settings, reminderDelayMinutes: Number(e.target.value) })}
              className="w-full p-5 bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-[24px] border border-transparent focus:border-brand-500/50 outline-none"
            >
              <option value={5}>5 Minutes</option>
              <option value={10}>10 Minutes</option>
              <option value={15}>15 Minutes</option>
              <option value={20}>20 Minutes</option>
              <option value={30}>30 Minutes</option>
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-2.5 ml-1">Max Reminders per Task</label>
            <select 
              value={settings.maxReminders}
              onChange={(e) => onUpdate({ ...settings, maxReminders: Number(e.target.value) })}
              className="w-full p-5 bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-[24px] border border-transparent focus:border-brand-500/50 outline-none"
            >
              <option value={1}>1 Reminder</option>
              <option value={2}>2 Reminders</option>
              <option value={3}>3 Reminders</option>
              <option value={5}>5 Reminders</option>
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-2.5 ml-1">Snooze Duration (Minutes)</label>
            <select 
              value={settings.snoozeDurationMinutes}
              onChange={(e) => onUpdate({ ...settings, snoozeDurationMinutes: Number(e.target.value) })}
              className="w-full p-5 bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-[24px] border border-transparent focus:border-brand-500/50 outline-none"
            >
              <option value={5}>5 Minutes</option>
              <option value={10}>10 Minutes</option>
              <option value={15}>15 Minutes</option>
              <option value={20}>20 Minutes</option>
            </select>
          </div>
        </div>

        <button 
          onClick={onClose}
          className="w-full mt-8 py-5 bg-gradient-to-r from-brand-600 to-blue-500 text-white rounded-[24px] font-bold text-lg shadow-xl shadow-brand-900/20 hover:opacity-90 transition-all active:scale-[0.98]"
        >
          Done
        </button>
      </motion.div>
    </div>
  );
}
