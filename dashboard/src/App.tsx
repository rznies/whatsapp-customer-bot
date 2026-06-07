import React, { useState, useEffect, useCallback } from 'react';
import { 
  Users, 
  Calendar, 
  Chat, 
  Clock, 
  XCircle, 
  Trash, 
  SignOut, 
  Lock, 
  ArrowsClockwise, 
  House, 
  UserCircle,
  CaretRight,
  Pause,
  Play
} from '@phosphor-icons/react';

// API Configuration
const API_BASE = '/dashboard/api';

// Types
interface AgencyOverview {
  totalClients: number;
  totalBookingsThisWeek: number;
  totalConversationsHappening: number;
  totalFollowupsPending: number;
}

interface Client {
  id: string;
  name: string;
  whatsapp_number: string;
  bookings_this_month: number;
  active_conversations: number;
}

interface Booking {
  id: string;
  client_id: string;
  customer_name: string;
  service: string;
  date: string;
  status: 'confirmed' | 'cancelled';
}

interface Conversation {
  id: string;
  customer_phone_number: string;
  client_id: string;
  current_state: string;
  partial_booking_data: any;
  last_messaged_at: string;
  paused: boolean;
}

interface FollowUp {
  id: string;
  booking_id: string;
  customer_phone: string;
  message_preview: string;
  scheduled_time: string;
}

interface ClientStats {
  bookings_this_month: number;
  bookings_this_week: number;
  conversations_today: number;
  followups_sent_this_month: number;
}

export default function App() {
  // Authentication State
  const [password, setPassword] = useState(() => localStorage.getItem('dashboard_password') || '');
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!localStorage.getItem('dashboard_password'));
  const [authError, setAuthError] = useState('');
  const [passwordInput, setPasswordInput] = useState('');

  // Navigation State
  const [view, setView] = useState<'overview' | 'clients'>('overview');
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  // Data State
  const [overviewStats, setOverviewStats] = useState<AgencyOverview | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  
  // Selected Client Data State
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [clientStats, setClientStats] = useState<ClientStats | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [followups, setFollowups] = useState<FollowUp[]>([]);
  
  // Date filter for bookings table (default to today YYYY-MM-DD)
  const [filterDate, setFilterDate] = useState(() => {
    const today = new Date();
    return today.toISOString().split('T')[0];
  });

  // UI States
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [refreshCountdown, setRefreshCountdown] = useState(30);

  // Fetch API Helper with Auth Header
  const apiFetch = useCallback(async (path: string, options: RequestInit = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      'x-dashboard-password': password,
      ...(options.headers || {}),
    };
    
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    
    if (response.status === 401) {
      // Clear invalid auth
      localStorage.removeItem('dashboard_password');
      setIsAuthenticated(false);
      setPassword('');
      throw new Error('Unauthorized');
    }
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP error ${response.status}`);
    }
    
    return response.json();
  }, [password]);

  // Auth Handler
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setAuthError('');
    try {
      // Test the password by fetching overview
      const headers = { 'x-dashboard-password': passwordInput };
      const response = await fetch(`${API_BASE}/overview`, { headers });
      
      if (response.ok) {
        localStorage.setItem('dashboard_password', passwordInput);
        setPassword(passwordInput);
        setIsAuthenticated(true);
      } else {
        setAuthError('Invalid password. Access denied.');
      }
    } catch (err) {
      setAuthError('Authentication failed. Server could not be reached.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('dashboard_password');
    setPassword('');
    setIsAuthenticated(false);
    setOverviewStats(null);
    setClients([]);
  };

  // Fetch Agency Overview Data
  const fetchOverviewData = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const [stats, clientList] = await Promise.all([
        apiFetch('/overview'),
        apiFetch('/clients')
      ]);
      setOverviewStats(stats);
      setClients(clientList);
      setLastRefreshed(new Date());
      setRefreshCountdown(30);
    } catch (err: any) {
      if (err.message !== 'Unauthorized') {
        setError('Failed to fetch agency overview stats.');
      }
    }
  }, [isAuthenticated, apiFetch]);

  // Fetch Client-Specific Data
  const fetchClientData = useCallback(async (clientId: string) => {
    if (!isAuthenticated) return;
    try {
      const [stats, bookingsList, convsList, followupsList] = await Promise.all([
        apiFetch(`/clients/${clientId}/stats`),
        apiFetch(`/clients/${clientId}/bookings?date=${filterDate}`),
        apiFetch(`/clients/${clientId}/conversations`),
        apiFetch(`/clients/${clientId}/followups`)
      ]);
      setClientStats(stats);
      setBookings(bookingsList);
      setConversations(convsList);
      setFollowups(followupsList);
      setLastRefreshed(new Date());
      setRefreshCountdown(30);
    } catch (err: any) {
      if (err.message !== 'Unauthorized') {
        setError('Failed to fetch client details.');
      }
    }
  }, [isAuthenticated, apiFetch, filterDate]);

  // Refresh Trigger
  const handleRefresh = useCallback(() => {
    setError(null);
    if (selectedClientId) {
      fetchClientData(selectedClientId);
    } else {
      fetchOverviewData();
    }
  }, [selectedClientId, fetchOverviewData, fetchClientData]);

  // Handle Booking Status Update
  const updateBookingStatus = async (bookingId: string, status: 'confirmed' | 'cancelled') => {
    try {
      await apiFetch(`/bookings/${bookingId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      handleRefresh();
    } catch (err: any) {
      alert(`Error updating booking status: ${err.message}`);
    }
  };

  // Handle Conversation Takeover
  const takeoverConversation = async (conversationId: string) => {
    try {
      await apiFetch(`/conversations/${conversationId}/takeover`, { method: 'PATCH' });
      handleRefresh();
    } catch (err: any) {
      alert(`Error pausing conversation: ${err.message}`);
    }
  };

  // Handle Conversation Resume
  const resumeConversation = async (conversationId: string) => {
    try {
      await apiFetch(`/conversations/${conversationId}/resume`, { method: 'PATCH' });
      handleRefresh();
    } catch (err: any) {
      alert(`Error resuming conversation: ${err.message}`);
    }
  };

  // Handle Delete Followup
  const deleteFollowup = async (followupId: string) => {
    if (!confirm('Are you sure you want to delete this pending follow-up message?')) return;
    try {
      await apiFetch(`/followups/${followupId}`, { method: 'DELETE' });
      handleRefresh();
    } catch (err: any) {
      alert(`Error deleting follow-up: ${err.message}`);
    }
  };

  // Setup Auto-Refresh
  useEffect(() => {
    if (!isAuthenticated) return;
    
    // Initial Fetch
    handleRefresh();

    // Timer for countdown
    const interval = setInterval(() => {
      setRefreshCountdown((prev) => {
        if (prev <= 1) {
          handleRefresh();
          return 30;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isAuthenticated, selectedClientId, filterDate, handleRefresh]);

  // Keep track of the selected client metadata
  useEffect(() => {
    if (selectedClientId) {
      const matched = clients.find(c => c.id === selectedClientId);
      if (matched) {
        setSelectedClient(matched);
      }
    } else {
      setSelectedClient(null);
    }
  }, [selectedClientId, clients]);

  // Loading Screen for Auth
  if (!isAuthenticated) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-slate-950 p-6">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-indigo-500/10 border border-indigo-500/20 rounded-full flex items-center justify-center text-indigo-400 mb-4 shadow-[0_0_15px_rgba(99,102,241,0.1)]">
              <Lock size={32} weight="bold" />
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Antigravity Dashboard</h1>
            <p className="text-slate-400 text-sm mt-1 text-center">Enter the security password to access the panel</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label htmlFor="password-input" className="block text-xs uppercase tracking-wider text-slate-400 font-medium mb-2">Password</label>
              <input
                id="password-input"
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="••••••••••••"
                className="w-full bg-slate-950 border border-slate-800 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                required
              />
              {authError && <p className="text-rose-500 text-xs mt-2 font-medium">{authError}</p>}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg py-3 text-sm font-semibold tracking-wide transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? 'Validating...' : 'Unlock Dashboard'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex bg-slate-50">
      {/* Sidebar - Dark theme */}
      <aside className="w-64 bg-slate-950 flex flex-col shrink-0 border-r border-slate-900">
        <div className="p-6 flex items-center gap-3 border-b border-slate-900">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-lg shadow-[0_0_10px_rgba(99,102,241,0.3)]">
            A
          </div>
          <div>
            <h2 className="text-sm font-bold text-white tracking-wide leading-none">Antigravity</h2>
            <span className="text-[10px] uppercase tracking-wider font-mono text-slate-500 font-bold">Agency Panel</span>
          </div>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-1">
          <button
            onClick={() => { setSelectedClientId(null); setView('overview'); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold tracking-wide transition-all ${
              view === 'overview' && !selectedClientId
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/10'
                : 'text-slate-400 hover:text-white hover:bg-slate-900'
            }`}
          >
            <House size={20} weight={view === 'overview' && !selectedClientId ? 'fill' : 'regular'} />
            Overview
          </button>
          
          <button
            onClick={() => { setView('clients'); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold tracking-wide transition-all ${
              view === 'clients' && !selectedClientId
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/10'
                : 'text-slate-400 hover:text-white hover:bg-slate-900'
            }`}
          >
            <Users size={20} weight={view === 'clients' && !selectedClientId ? 'fill' : 'regular'} />
            Clients
          </button>

          {/* Quick List of Clients in Sidebar */}
          {clients.length > 0 && (
            <div className="pt-4 mt-4 border-t border-slate-900">
              <span className="px-4 text-[10px] uppercase tracking-widest font-mono text-slate-500 font-bold block mb-2">Active Tenants</span>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {clients.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setSelectedClientId(c.id); setView('clients'); }}
                    className={`w-full flex items-center justify-between px-4 py-2 rounded-lg text-xs transition-all ${
                      selectedClientId === c.id
                        ? 'bg-slate-900 text-indigo-400 font-semibold'
                        : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900/50'
                    }`}
                  >
                    <span className="truncate">{c.name}</span>
                    <CaretRight size={12} className={selectedClientId === c.id ? 'opacity-100' : 'opacity-0'} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </nav>

        {/* Sidebar Footer */}
        <div className="p-4 border-t border-slate-900">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-between px-4 py-3 text-slate-500 hover:text-white hover:bg-slate-900/50 rounded-lg text-xs font-semibold tracking-wide transition-all"
          >
            <span className="flex items-center gap-2">
              <SignOut size={16} />
              Lock Panel
            </span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* Header */}
        <header className="h-16 border-b border-slate-200 bg-white flex items-center justify-between px-8 shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold tracking-tight text-slate-800">
              {selectedClientId ? `${selectedClient?.name || 'Client'} Dashboard` : view === 'clients' ? 'Clients' : 'Agency Overview'}
            </h1>
            {selectedClientId && (
              <span className="text-[10px] bg-slate-100 text-slate-600 font-mono font-bold px-2 py-0.5 rounded uppercase tracking-wider">
                {selectedClient?.whatsapp_number}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4">
            {/* Auto Refresh Indicator */}
            {lastRefreshed && (
              <span className="text-xs text-slate-400 font-medium">
                Refreshed: {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
              <span>Auto-refreshing in <span className="font-mono font-bold">{refreshCountdown}s</span></span>
            </div>
            
            <button
              onClick={handleRefresh}
              className="p-2 border border-slate-200 hover:border-slate-300 text-slate-600 rounded-lg bg-white hover:bg-slate-50 transition-colors shadow-sm active:scale-[0.98]"
              title="Refresh Data Now"
            >
              <ArrowsClockwise size={16} />
            </button>
          </div>
        </header>

        {/* Notification Banner for Errors */}
        {error && (
          <div className="mx-8 mt-6 p-4 bg-rose-50 border border-rose-100 rounded-xl text-rose-800 text-sm flex items-center gap-3">
            <XCircle size={18} className="text-rose-500 shrink-0" />
            <span className="font-medium">{error}</span>
          </div>
        )}

        {/* Content Body */}
        <div className="p-8">
          {/* VIEW: AGENCY OVERVIEW */}
          {!selectedClientId && view === 'overview' && (
            <div className="space-y-8">
              {/* Stat Cards */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">Total Clients</span>
                    <div className="w-10 h-10 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600 flex items-center justify-center">
                      <Users size={20} weight="bold" />
                    </div>
                  </div>
                  <span className="text-3xl font-bold font-mono text-slate-800">{overviewStats?.totalClients ?? '0'}</span>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">Bookings This Week</span>
                    <div className="w-10 h-10 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600 flex items-center justify-center">
                      <Calendar size={20} weight="bold" />
                    </div>
                  </div>
                  <span className="text-3xl font-bold font-mono text-slate-800">{overviewStats?.totalBookingsThisWeek ?? '0'}</span>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">Conversations (24h)</span>
                    <div className="w-10 h-10 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600 flex items-center justify-center">
                      <Chat size={20} weight="bold" />
                    </div>
                  </div>
                  <span className="text-3xl font-bold font-mono text-slate-800">{overviewStats?.totalConversationsHappening ?? '0'}</span>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">Pending Follow-ups</span>
                    <div className="w-10 h-10 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600 flex items-center justify-center">
                      <Clock size={20} weight="bold" />
                    </div>
                  </div>
                  <span className="text-3xl font-bold font-mono text-slate-800">{overviewStats?.totalFollowupsPending ?? '0'}</span>
                </div>
              </div>

              {/* Client List Table */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                <div className="px-6 py-5 border-b border-slate-200 flex items-center justify-between">
                  <h3 className="font-bold text-slate-800">All Business Clients</h3>
                  <span className="text-xs font-mono text-slate-500 font-bold">{clients.length} Clients Registered</span>
                </div>
                
                {clients.length === 0 ? (
                  <div className="p-12 text-center text-slate-400">No active clients found in database.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase tracking-wider text-[10px] font-semibold">
                        <tr>
                          <th className="px-6 py-4">Client Name</th>
                          <th className="px-6 py-4">WhatsApp Number</th>
                          <th className="px-6 py-4">Bookings This Month</th>
                          <th className="px-6 py-4">Active Conversations</th>
                          <th className="px-6 py-4 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-700">
                        {clients.map((client) => (
                          <tr key={client.id} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-6 py-4 font-bold text-slate-900">{client.name}</td>
                            <td className="px-6 py-4 font-mono text-xs">{client.whatsapp_number || 'Not Configured'}</td>
                            <td className="px-6 py-4 font-mono font-bold text-slate-800">{client.bookings_this_month}</td>
                            <td className="px-6 py-4">
                              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                                client.active_conversations > 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-slate-100 text-slate-500'
                              }`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${client.active_conversations > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`}></span>
                                {client.active_conversations} Active
                              </span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <button
                                onClick={() => { setSelectedClientId(client.id); setView('clients'); }}
                                className="px-4 py-1.5 text-xs font-semibold text-indigo-600 hover:text-white border border-indigo-200 hover:bg-indigo-600 hover:border-indigo-600 rounded-lg transition-all active:scale-[0.98]"
                              >
                                View Dashboard
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* VIEW: CLIENT LIST (General Directory) */}
          {!selectedClientId && view === 'clients' && (
            <div className="space-y-6">
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                <div className="px-6 py-5 border-b border-slate-200 flex items-center justify-between">
                  <h3 className="font-bold text-slate-800">Business Client Directory</h3>
                </div>
                
                {clients.length === 0 ? (
                  <div className="p-12 text-center text-slate-400">No active clients found.</div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-6">
                    {clients.map((c) => (
                      <div 
                        key={c.id}
                        onClick={() => setSelectedClientId(c.id)}
                        className="bg-white border border-slate-200 hover:border-indigo-300 rounded-xl p-6 cursor-pointer hover:shadow-md transition-all group active:scale-[0.99]"
                      >
                        <div className="flex items-center justify-between mb-4">
                          <h4 className="font-bold text-slate-800 group-hover:text-indigo-600 transition-colors">{c.name}</h4>
                          <UserCircle size={28} className="text-slate-400 group-hover:text-indigo-500 transition-colors" />
                        </div>
                        <p className="text-xs text-slate-400 font-mono mb-6">{c.whatsapp_number || 'No whatsapp number'}</p>
                        
                        <div className="flex items-center justify-between border-t border-slate-100 pt-4 mt-2">
                          <span className="text-xs text-slate-500">View Client Portal</span>
                          <CaretRight size={16} className="text-indigo-600" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* VIEW: CLIENT DEDICATED VIEW */}
          {selectedClientId && (
            <div className="space-y-8">
              {/* Back to overview button */}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setSelectedClientId(null)}
                  className="text-xs text-indigo-600 hover:text-indigo-500 font-semibold flex items-center gap-1"
                >
                  &larr; Back to Agency Overview
                </button>
              </div>

              {/* SECTION 4: QUICK STATS */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">Bookings (Month)</span>
                    <div className="w-10 h-10 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600 flex items-center justify-center">
                      <Calendar size={20} weight="bold" />
                    </div>
                  </div>
                  <span className="text-3xl font-bold font-mono text-slate-800">{clientStats?.bookings_this_month ?? '0'}</span>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">Bookings (Week)</span>
                    <div className="w-10 h-10 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600 flex items-center justify-center">
                      <Calendar size={20} weight="bold" />
                    </div>
                  </div>
                  <span className="text-3xl font-bold font-mono text-slate-800">{clientStats?.bookings_this_week ?? '0'}</span>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs uppercase tracking-wider font-semibold text-slate-400 font-medium">Conversations (Today)</span>
                    <div className="w-10 h-10 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600 flex items-center justify-center">
                      <Chat size={20} weight="bold" />
                    </div>
                  </div>
                  <span className="text-3xl font-bold font-mono text-slate-800">{clientStats?.conversations_today ?? '0'}</span>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">Follow-ups Sent (Month)</span>
                    <div className="w-10 h-10 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600 flex items-center justify-center">
                      <Clock size={20} weight="bold" />
                    </div>
                  </div>
                  <span className="text-3xl font-bold font-mono text-slate-800">{clientStats?.followups_sent_this_month ?? '0'}</span>
                </div>
              </div>

              {/* Grid for Bookings & Conversations */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* SECTION 1: TODAY'S BOOKINGS */}
                <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                  <div className="px-6 py-5 border-b border-slate-200 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div>
                      <h3 className="font-bold text-slate-800">Bookings Scheduler</h3>
                      <p className="text-xs text-slate-400 mt-0.5">Manage appointment confirmations and cancellations</p>
                    </div>
                    {/* Date picker */}
                    <div>
                      <input
                        type="date"
                        value={filterDate}
                        onChange={(e) => setFilterDate(e.target.value)}
                        className="bg-slate-50 border border-slate-200 text-slate-700 text-xs rounded-lg px-3 py-1.5 font-semibold focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                  </div>

                  {bookings.length === 0 ? (
                    <div className="p-12 text-center text-slate-400 flex-1 flex flex-col items-center justify-center">
                      <Calendar size={36} className="text-slate-300 mb-2" />
                      No bookings scheduled for this date.
                    </div>
                  ) : (
                    <div className="overflow-x-auto flex-1">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase tracking-wider text-[10px] font-semibold">
                          <tr>
                            <th className="px-6 py-3">Customer Name</th>
                            <th className="px-6 py-3">Service</th>
                            <th className="px-6 py-3">Scheduled Time</th>
                            <th className="px-6 py-3">Status</th>
                            <th className="px-6 py-3 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-slate-700">
                          {bookings.map((booking) => (
                            <tr key={booking.id} className="hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-4 font-bold text-slate-800">{booking.customer_name}</td>
                              <td className="px-6 py-4 text-xs font-semibold text-slate-600">{booking.service}</td>
                              <td className="px-6 py-4 font-mono text-xs text-slate-500">
                                {new Date(booking.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </td>
                              <td className="px-6 py-4">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                                  booking.status === 'confirmed'
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                                    : 'bg-rose-50 text-rose-700 border border-rose-100'
                                }`}>
                                  {booking.status}
                                </span>
                              </td>
                              <td className="px-6 py-4 text-right space-x-2">
                                {booking.status === 'confirmed' ? (
                                  <button
                                    onClick={() => updateBookingStatus(booking.id, 'cancelled')}
                                    className="px-2.5 py-1 border border-rose-200 hover:bg-rose-50 hover:border-rose-300 text-rose-700 text-xs font-semibold rounded-lg transition-all active:scale-[0.98]"
                                  >
                                    Cancel
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => updateBookingStatus(booking.id, 'confirmed')}
                                    className="px-2.5 py-1 border border-emerald-200 hover:bg-emerald-50 hover:border-emerald-300 text-emerald-700 text-xs font-semibold rounded-lg transition-all active:scale-[0.98]"
                                  >
                                    Confirm
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* SECTION 2: ALL CONVERSATIONS */}
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                  <div className="px-6 py-5 border-b border-slate-200">
                    <h3 className="font-bold text-slate-800">Live Agent Webhook sessions</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Control bot responses and state machine pauses</p>
                  </div>

                  {conversations.length === 0 ? (
                    <div className="p-12 text-center text-slate-400 flex-1 flex flex-col items-center justify-center">
                      <Chat size={36} className="text-slate-300 mb-2" />
                      No webhook sessions active.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100 overflow-y-auto max-h-[400px]">
                      {conversations.map((conv) => (
                        <div 
                          key={conv.id} 
                          className={`p-4 transition-colors flex flex-col gap-3 ${
                            conv.paused 
                              ? 'bg-amber-50/50 border-l-4 border-amber-500' 
                              : 'hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-start justify-between">
                            <div>
                              <span className="font-mono text-sm font-bold text-slate-800">{conv.customer_phone_number}</span>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-[10px] bg-slate-100 border border-slate-200 text-slate-600 rounded px-1.5 py-0.5 font-bold uppercase tracking-wider">
                                  {conv.current_state}
                                </span>
                                {conv.paused && (
                                  <span className="text-[9px] bg-amber-100 border border-amber-200 text-amber-800 font-bold px-1.5 py-0.5 rounded flex items-center gap-1">
                                    <Pause size={10} weight="bold" /> Paused (Manual)
                                  </span>
                                )}
                              </div>
                            </div>

                            <span className="text-[10px] text-slate-400 font-mono">
                              {new Date(conv.last_messaged_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>

                          <div className="flex justify-end border-t border-slate-100/60 pt-2.5">
                            {conv.paused ? (
                              <button
                                onClick={() => resumeConversation(conv.id)}
                                className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg transition-all active:scale-[0.98] flex items-center gap-1.5"
                              >
                                <Play size={12} weight="fill" />
                                Resume Bot
                              </button>
                            ) : (
                              <button
                                onClick={() => takeoverConversation(conv.id)}
                                className="px-3 py-1 border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg transition-all active:scale-[0.98] flex items-center gap-1.5"
                              >
                                <Pause size={12} weight="bold" />
                                Take Over
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* SECTION 3: UPCOMING FOLLOW-UPS */}
              <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                <div className="px-6 py-5 border-b border-slate-200">
                  <h3 className="font-bold text-slate-800">Pending Automated Follow-ups</h3>
                  <p className="text-xs text-slate-400 mt-0.5">Automated outreach trigger queue</p>
                </div>

                {followups.length === 0 ? (
                  <div className="p-12 text-center text-slate-400">
                    No follow-ups currently scheduled in queue.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase tracking-wider text-[10px] font-semibold">
                        <tr>
                          <th className="px-6 py-4">Customer Phone</th>
                          <th className="px-6 py-4">Message Preview</th>
                          <th className="px-6 py-4">Scheduled Date & Time</th>
                          <th className="px-6 py-4 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-700">
                        {followups.map((f) => (
                          <tr key={f.id} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-6 py-4 font-mono text-sm font-bold text-slate-800">{f.customer_phone}</td>
                            <td className="px-6 py-4 text-slate-500 font-medium italic text-xs max-w-md truncate">
                              "{f.message_preview}"
                            </td>
                            <td className="px-6 py-4 font-mono text-xs text-slate-500">
                              {new Date(f.scheduled_time).toLocaleString()}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <button
                                onClick={() => deleteFollowup(f.id)}
                                className="p-1.5 border border-rose-200 hover:bg-rose-50 hover:border-rose-300 text-rose-600 rounded-lg transition-all active:scale-[0.98]"
                                title="Remove follow-up from queue"
                              >
                                <Trash size={16} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
