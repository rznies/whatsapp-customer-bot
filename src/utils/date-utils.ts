export function getStartOfWeek(baseDate: Date = new Date()): Date {
  const date = new Date(baseDate.getTime());
  const day = date.getDay();
  // Monday start: if day is 0 (Sunday), we subtract 6. Otherwise we subtract day - 1.
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const startOfWeek = new Date(date.setDate(diff));
  startOfWeek.setHours(0, 0, 0, 0);
  return startOfWeek;
}

export function getStartOfMonth(baseDate: Date = new Date()): Date {
  return new Date(baseDate.getFullYear(), baseDate.getMonth(), 1, 0, 0, 0, 0);
}

export function getStartOfToday(baseDate: Date = new Date()): Date {
  const today = new Date(baseDate.getTime());
  today.setHours(0, 0, 0, 0);
  return today;
}

export function getActiveLimit24h(baseDate: Date = new Date()): Date {
  return new Date(baseDate.getTime() - 24 * 60 * 60 * 1000);
}

export function getDayRange(dateString?: string, baseDate: Date = new Date()): { start: Date; end: Date } {
  if (dateString && typeof dateString === 'string') {
    const start = new Date(`${dateString}T00:00:00.000Z`);
    const end = new Date(`${dateString}T23:59:59.999Z`);
    return { start, end };
  }
  
  const today = new Date(baseDate.getTime());
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const start = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
  const end = new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`);
  return { start, end };
}
