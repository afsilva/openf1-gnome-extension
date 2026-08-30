import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const API_BASE = 'https://api.openf1.org/v1';

const REFRESH_WEEK_SECONDS = 24 * 60 * 60;      // once/day
const REFRESH_WEEKEND_SECONDS = 60 * 60;         // once/hour
const SCHEDULER_TICK_SECONDS = 15 * 60;          // lightweight local tick
const RESULT_CACHE_SECONDS = 30 * 24 * 60 * 60;  // completed results are stable
const MAX_CACHE_BYTES = 2 * 1024 * 1024;         // 2MB on-disk cache cap
const MAX_ENDPOINT_CACHE_ENTRIES = 200;
const MAX_RESPONSE_BYTES = 1024 * 1024;           // 1MB response body cap
const ALLOWED_ENDPOINTS = new Set(['meetings', 'sessions', 'session_result', 'drivers']);
const UI_SCHEMA_VERSION = 4;
const BUILD_VERSION = '4';
const BUILD_COMMIT = 'a02279b';

const _unknownCountryCodesLogged = new Set();

function isoNow() {
    return GLib.DateTime.new_now_utc().format_iso8601();
}

function unixNow() {
    return GLib.DateTime.new_now_utc().to_unix();
}

function parseIso(iso) {
    return GLib.DateTime.new_from_iso8601(iso, null);
}

function formatTz(iso, tz) {
    try {
        const dt = parseIso(iso);
        if (!dt)
            return 'N/A';

        if (tz === 'utc')
            return dt.to_timezone(GLib.TimeZone.new_utc()).format('%Y-%m-%d %H:%M UTC');

        if (tz === 'local')
            return dt.to_local().format('%Y-%m-%d %H:%M %Z');

        return dt.to_timezone(GLib.TimeZone.new(tz)).format('%Y-%m-%d %H:%M %Z');
    } catch (_e) {
        return 'N/A';
    }
}

function formatCompactTz(iso, tz) {
    try {
        const dt = parseIso(iso);
        if (!dt)
            return 'N/A';

        if (tz === 'utc')
            return dt.to_timezone(GLib.TimeZone.new_utc()).format('%m-%d %H:%M');

        if (tz === 'local')
            return dt.to_local().format('%m-%d %H:%M');

        return dt.to_timezone(GLib.TimeZone.new(tz)).format('%m-%d %H:%M');
    } catch (_e) {
        return 'N/A';
    }
}

function parseOffsetToSeconds(offset) {
    // expected examples: "+02:00", "-05:30"
    if (!offset || typeof offset !== 'string')
        return null;

    const m = offset.trim().match(/^([+-])(\d{2}):(\d{2})$/);
    if (!m)
        return null;

    const sign = m[1] === '-' ? -1 : 1;
    const hh = Number.parseInt(m[2], 10);
    const mm = Number.parseInt(m[3], 10);
    if (!Number.isFinite(hh) || !Number.isFinite(mm))
        return null;

    return sign * ((hh * 60 * 60) + (mm * 60));
}

function formatCompactOffset(iso, offset) {
    try {
        const dt = parseIso(iso);
        if (!dt)
            return 'N/A';

        const sec = parseOffsetToSeconds(offset);
        if (sec === null)
            return formatCompactTz(iso, 'utc');

        const shifted = dt.to_timezone(GLib.TimeZone.new_utc()).add_seconds(sec);
        return shifted ? shifted.format('%m-%d %H:%M') : 'N/A';
    } catch (_e) {
        return 'N/A';
    }
}

function formatUpdatedTs(unixTs) {
    if (!unixTs)
        return 'never';

    try {
        const dt = GLib.DateTime.new_from_unix_local(unixTs);
        return dt ? dt.format('%m-%d %H:%M %Z') : 'unknown';
    } catch (_e) {
        return 'unknown';
    }
}

function countryCodeLabel(code) {
    if (!code)
        return 'N/A';

    const upper = String(code).toUpperCase().trim();
    if (/^[A-Z]{2,3}$/.test(upper))
        return upper;

    if (!_unknownCountryCodesLogged.has(upper)) {
        _unknownCountryCodesLogged.add(upper);
        console.warn(`[openf1dashboard] Unknown country code: ${upper}`);
    }
    return 'N/A';
}

function abbreviateSessionName(sessionName) {
    const n = String(sessionName || '').toLowerCase().trim();
    if (!n)
        return 'UNK';

    if (n === 'practice 1' || n === 'free practice 1') return 'FP1';
    if (n === 'practice 2' || n === 'free practice 2') return 'FP2';
    if (n === 'practice 3' || n === 'free practice 3') return 'FP3';
    if (n === 'practice') return 'FP';
    if (n === 'qualifying') return 'Q';
    if (n === 'sprint qualifying' || n === 'sprint shootout') return 'SQ';
    if (n === 'sprint') return 'SPR';
    if (n === 'race') return 'R';

    // fallback: take first letters of up to 3 words
    const parts = n.split(/\s+/).filter(Boolean);
    return parts.slice(0, 3).map(p => p[0].toUpperCase()).join('');
}

function fitCell(text, width) {
    const s = String(text ?? '');
    if (s.length === width)
        return s;
    if (s.length < width)
        return s.padEnd(width, ' ');
    if (width <= 1)
        return s.slice(0, width);
    return `${s.slice(0, width - 1)}…`;
}

function sanitizeUiText(value, maxLen = 160, preserveNewlines = false) {
    const text = String(value ?? '');
    // Strip control chars but optionally preserve newline for multi-line table cells
    let clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (!preserveNewlines)
        clean = clean.replace(/[\r\n]+/g, ' ');
    return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function isValidPathAndQuery(pathAndQuery) {
    if (typeof pathAndQuery !== 'string' || !pathAndQuery.includes('?'))
        return false;

    const [endpoint, query] = pathAndQuery.split('?', 2);
    if (!ALLOWED_ENDPOINTS.has(endpoint))
        return false;

    // Query keys/values allow typical URL-safe characters used by OpenF1 filters
    return /^[a-zA-Z0-9_=&.,:%+-]*$/.test(query);
}

class OpenF1Indicator extends PanelMenu.Button {
    static cacheFilePath() {
        return GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'openf1-dashboard-cache.json',
        ]);
    }
    static {
        GObject.registerClass(this);
    }

    constructor(buildVersion = '1') {
        super(0.0, 'OpenF1 Dashboard');
        this._buildVersion = String(buildVersion);

        this._http = new Soup.Session({
            timeout: 15,
            user_agent: 'OpenF1-Dashboard-GNOME/1.0',
        });
        this._refreshSourceId = 0;
        this._refreshNowSignalId = 0;
        this._isRefreshing = false;
        this._isDestroyed = false;
        this._hasCalendarData = false;
        this._hasStandingsData = false;

        this._cachePath = OpenF1Indicator.cacheFilePath();
        this._cache = this._createDefaultCache();

        this._label = new St.Label({
            text: 'F1',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this.menu.box.add_style_class_name('openf1-menu-box');

        this._calendarHeader = new PopupMenu.PopupMenuItem('Calendar', {reactive: false, can_focus: false});
        this.menu.addMenuItem(this._calendarHeader);
        this._calendarContent = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._calendarContent);

        this._refreshNowItem = new PopupMenu.PopupMenuItem('Refresh now');
        this._refreshNowSignalId = this._refreshNowItem.connect('activate', () => {
            this._onRefreshNow();
        });
        this.menu.addMenuItem(this._refreshNowItem);

        this._buildInfoItem = new PopupMenu.PopupMenuItem(`Build: v${this._buildVersion} (${BUILD_COMMIT})`, {reactive: false, can_focus: false});
        this._buildInfoItem.add_style_class_name('openf1-row-dim');
        this.menu.addMenuItem(this._buildInfoItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._driversHeader = new PopupMenu.PopupMenuItem('Championship (Top 10)', {reactive: false, can_focus: false});
        this.menu.addMenuItem(this._driversHeader);
        this._driversContent = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._driversContent);

        this._setSectionMessage(this._calendarContent, 'Loading calendar…');
        this._setSectionMessage(this._driversContent, 'Loading standings…');

        this._initAsync();

        // Lightweight scheduler tick: refresh only when policy says due
        this._refreshSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SCHEDULER_TICK_SECONDS, () => {
            this._refresh(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        this._isDestroyed = true;

        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        if (this._refreshNowSignalId && this._refreshNowItem) {
            this._refreshNowItem.disconnect(this._refreshNowSignalId);
            this._refreshNowSignalId = 0;
        }

        if (this._http) {
            this._http.abort();
            this._http = null;
        }

        super.destroy();
    }

    _createDefaultCache() {
        return {
            endpoints: {},
            ui: {},
            meta: {lastRefreshTs: 0, refreshInterval: REFRESH_WEEK_SECONDS, lastRefreshSource: 'CACHE', uiSchemaVersion: UI_SCHEMA_VERSION},
            standings: {sessionPoints: {}, driverInfo: {}},
        };
    }

    async _initAsync() {
        this._cache = await this._loadDiskCacheAsync();
        if (this._isDestroyed)
            return;

        // Paint from cache immediately if available
        this._applyCachedUi();

        // Initial network refresh
        this._refresh(true);
    }

    _normalizeDiskCache(parsed) {
        if (!parsed || typeof parsed !== 'object')
            return this._createDefaultCache();

        if (!parsed.endpoints)
            parsed.endpoints = {};
        if (!parsed.ui)
            parsed.ui = {};
        if (!parsed.meta)
            parsed.meta = {lastRefreshTs: 0, refreshInterval: REFRESH_WEEK_SECONDS, lastRefreshSource: 'CACHE', uiSchemaVersion: UI_SCHEMA_VERSION};
        if (!parsed.meta.lastRefreshSource)
            parsed.meta.lastRefreshSource = 'CACHE';

        if ((parsed.meta.uiSchemaVersion || 0) < UI_SCHEMA_VERSION) {
            parsed.ui = {};
            parsed.meta.uiSchemaVersion = UI_SCHEMA_VERSION;
        }
        if (!parsed.standings)
            parsed.standings = {sessionPoints: {}, driverInfo: {}};
        if (!parsed.standings.sessionPoints)
            parsed.standings.sessionPoints = {};
        if (!parsed.standings.driverInfo)
            parsed.standings.driverInfo = {};
        return parsed;
    }

    async _loadDiskCacheAsync() {
        try {
            const file = Gio.File.new_for_path(this._cachePath);
            const bytes = await new Promise((resolve, reject) => {
                file.load_contents_async(null, (_file, result) => {
                    try {
                        const [, contents] = file.load_contents_finish(result);
                        resolve(contents);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            const text = new TextDecoder().decode(bytes);
            return this._normalizeDiskCache(JSON.parse(text));
        } catch (_e) {
            return this._createDefaultCache();
        }
    }

    _saveDiskCache() {
        try {
            // Bound endpoint cache growth
            const entries = Object.entries(this._cache.endpoints || {});
            if (entries.length > MAX_ENDPOINT_CACHE_ENTRIES) {
                entries.sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
                this._cache.endpoints = Object.fromEntries(entries.slice(0, MAX_ENDPOINT_CACHE_ENTRIES));
            }

            const file = Gio.File.new_for_path(this._cachePath);
            let data = JSON.stringify(this._cache);

            // If oversized, drop endpoint cache first and retry once
            if (data.length > MAX_CACHE_BYTES) {
                this._cache.endpoints = {};
                data = JSON.stringify(this._cache);
            }

            if (data.length <= MAX_CACHE_BYTES)
                file.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (_e) {
            // best effort cache
        }
    }

    _applyCachedUi() {
        const ui = this._cache.ui || {};
        if (Array.isArray(ui.calendarRows) && ui.calendarRows.length) {
            this._setRows(this._calendarContent, ui.calendarRows);
            this._hasCalendarData = true;
        }
        if (Array.isArray(ui.driverRows) && ui.driverRows.length) {
            this._setRows(this._driversContent, ui.driverRows);
            this._hasStandingsData = true;
        }
        // teamRows kept in cache for compatibility, rendered in unified standings table
        if (ui.panelLabel)
            this._label.text = sanitizeUiText(ui.panelLabel, 32);
    }

    _endpointCacheGet(key, maxAgeSec) {
        const entry = this._cache.endpoints?.[key];
        if (!entry)
            return null;
        if ((unixNow() - (entry.ts || 0)) > maxAgeSec)
            return null;
        return entry.data;
    }

    _endpointCacheSet(key, data) {
        this._cache.endpoints[key] = {ts: unixNow(), data};
    }

    _isRaceWeekend(meetings, sessions) {
        if (!meetings?.length || !sessions?.length)
            return false;

        const now = parseIso(isoNow());
        const byMeeting = new Map();
        for (const s of sessions) {
            if (!byMeeting.has(s.meeting_key))
                byMeeting.set(s.meeting_key, []);
            byMeeting.get(s.meeting_key).push(s);
        }

        const sorted = [...meetings].sort((a, b) => parseIso(a.date_start).to_unix() - parseIso(b.date_start).to_unix());
        for (const m of sorted) {
            const mStart = parseIso(m.date_start);
            const mEnd = parseIso(m.date_end);
            const mSessions = byMeeting.get(m.meeting_key) || [];
            const activeSessions = mSessions.filter(s => !s.is_cancelled);
            if (!activeSessions.length)
                continue;

            if (now.compare(mStart) >= 0 && now.compare(mEnd) <= 0)
                return true;

            if (now.compare(mStart) < 0) {
                // upcoming weekend: consider weekend mode when next non-cancelled event is within 72h
                const first = activeSessions[0];
                if (!first)
                    continue;
                const delta = parseIso(first.date_start).to_unix() - now.to_unix();
                return delta <= (72 * 60 * 60);
            }
        }

        return false;
    }

    _getRefreshIntervalForData(meetings, sessions) {
        return this._isRaceWeekend(meetings, sessions) ? REFRESH_WEEKEND_SECONDS : REFRESH_WEEK_SECONDS;
    }

    _isRefreshDue(force = false) {
        if (force)
            return true;

        const last = this._cache.meta?.lastRefreshTs || 0;
        const interval = this._cache.meta?.refreshInterval || REFRESH_WEEK_SECONDS;
        return (unixNow() - last) >= interval;
    }

    async _fetchJsonCached(pathAndQuery, maxAgeSec, forceApi = false) {
        if (!forceApi) {
            const cached = this._endpointCacheGet(pathAndQuery, maxAgeSec);
            if (cached)
                return {data: cached, source: 'CACHE'};
        }

        const data = await this._fetchJson(pathAndQuery);
        this._endpointCacheSet(pathAndQuery, data);
        return {data, source: 'API'};
    }

    _clearSection(section) {
        section.removeAll();
    }

    _createCompactRow(text, isDim = false, className = null, preserveNewlines = false) {
        const safeText = sanitizeUiText(text, 220, preserveNewlines);
        const item = new PopupMenu.PopupMenuItem(safeText, {reactive: false, can_focus: false});
        item.add_style_class_name('openf1-row-compact');
        if (className)
            item.add_style_class_name(className);
        if (isDim)
            item.add_style_class_name('openf1-row-dim');
        return item;
    }

    _setSectionMessage(section, message) {
        this._clearSection(section);
        section.addMenuItem(this._createCompactRow(message));
    }

    _setRows(section, rows) {
        this._clearSection(section);
        for (const row of rows) {
            if (typeof row === 'string') {
                section.addMenuItem(this._createCompactRow(row));
            } else {
                section.addMenuItem(this._createCompactRow(row.text, !!row.dim, row.className || null, !!row.preserveNewlines));
            }
        }
    }

    async _onRefreshNow() {
        if (this._isRefreshing)
            return;

        if (this._refreshNowItem)
            this._refreshNowItem.label.text = 'Refreshing…';

        try {
            await this._refresh(true);
        } finally {
            if (this._refreshNowItem)
                this._refreshNowItem.label.text = 'Refresh now';
        }
    }

    async _fetchJson(pathAndQuery) {
        if (!isValidPathAndQuery(pathAndQuery))
            throw new Error('Invalid API query');

        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', `${API_BASE}/${pathAndQuery}`);
            this._http.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_session, result) => {
                try {
                    const bytes = this._http.send_and_read_finish(result);
                    const status = message.status_code ?? 0;
                    const dataBytes = bytes.get_data();

                    if (dataBytes.length > MAX_RESPONSE_BYTES)
                        throw new Error('API response too large');

                    const text = new TextDecoder().decode(dataBytes);

                    if (status === 429)
                        throw new Error('OpenF1 API rate limit reached (429)');

                    if (status === 401)
                        throw new Error('OpenF1 API restricted during live session (401)');

                    if (status < 200 || status >= 300)
                        throw new Error(`HTTP ${status}`);

                    const parsed = JSON.parse(text);
                    if (!Array.isArray(parsed))
                        throw new Error('Invalid API payload');
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _refresh(force = false) {
        if (this._isRefreshing)
            return;

        this._isRefreshing = true;
        let sessions = null;
        let meetings = null;
        let apiUsed = false;

        try {

        // Always re-evaluate refresh policy from cached schedule data
        const year = GLib.DateTime.new_now_utc().get_year();
        const cachedMeetings = this._endpointCacheGet(`meetings?year=${year}`, 7 * 24 * 60 * 60);
        const cachedSessions = this._endpointCacheGet(`sessions?year=${year}`, 7 * 24 * 60 * 60);
        if (cachedMeetings && cachedSessions) {
            this._cache.meta.refreshInterval = this._getRefreshIntervalForData(cachedMeetings, cachedSessions);
            this._saveDiskCache();
        }

        if (!this._isRefreshDue(force))
            return;

        // Calendar path
        try {
            const forceApi = !!force;
            const [meetingsResp, sessionsResp] = await Promise.all([
                this._fetchJsonCached(`meetings?year=${year}`, 24 * 60 * 60, forceApi),
                this._fetchJsonCached(`sessions?year=${year}`, 24 * 60 * 60, forceApi),
            ]);
            meetings = meetingsResp.data;
            sessions = sessionsResp.data;
            apiUsed = apiUsed || meetingsResp.source === 'API' || sessionsResp.source === 'API';

            this._updateCalendar(meetings, sessions);
        } catch (e) {
            const msg = String(e?.message || e);
            if (msg.includes('429')) {
                this._label.text = 'F1 | RL';
                if (!this._hasCalendarData)
                    this._setSectionMessage(this._calendarContent, 'OpenF1 rate limited (429). Using cache.');
            } else if (msg.includes('401')) {
                this._label.text = 'F1 | LOCK';
                if (!this._hasCalendarData)
                    this._setSectionMessage(this._calendarContent, 'OpenF1 restricted during live session (401). Showing cache.');
            } else {
                this._label.text = 'F1 | !';
                if (!this._hasCalendarData)
                    this._setSectionMessage(this._calendarContent, 'Calendar data unavailable (network/API error).');
            }
        }

        // Standings path (independent from calendar failures)
        try {
            if (!sessions) {
                const sessResp = await this._fetchJsonCached(`sessions?year=${year}`, 24 * 60 * 60, true);
                sessions = sessResp.data;
                apiUsed = apiUsed || sessResp.source === 'API';
            }

            const standings = await this._buildStandings(sessions);
            apiUsed = apiUsed || standings.source === 'API';
            this._updateStandings(standings);
            this._saveDiskCache();
        } catch (e) {
            const msg = String(e?.message || e);
            if (msg.includes('429')) {
                if (!this._hasStandingsData)
                    this._setSectionMessage(this._driversContent, 'Rate limited (429). No cached standings yet.');
            } else if (msg.includes('401')) {
                if (!this._hasStandingsData)
                    this._setSectionMessage(this._driversContent, 'OpenF1 restricted during live session (401). Showing cache.');
            } else {
                if (!this._hasStandingsData)
                    this._setSectionMessage(this._driversContent, 'Standings unavailable (network/API error).');
            }
        }

        // Update policy + persist cache only when schedule endpoints are available
        if (meetings && sessions) {
            const interval = this._getRefreshIntervalForData(meetings, sessions);
            this._cache.meta.lastRefreshTs = unixNow();
            this._cache.meta.lastRefreshSource = apiUsed ? 'API' : 'CACHE';
            this._cache.meta.refreshInterval = interval;
            this._saveDiskCache();
        }
        } finally {
            this._isRefreshing = false;
        }
    }

    _tzNameFromOffset(offset) {
        if (!offset)
            return 'UTC';
        return `UTC${offset.slice(0, 6)}`;
    }

    _sessionIsRaceLike(session) {
        const n = (session?.session_name || '').toLowerCase();
        const t = (session?.session_type || '').toLowerCase();
        return n === 'race' || n.includes('sprint') || t === 'race' || t.includes('sprint');
    }

    _isSessionLive(session, now) {
        const start = parseIso(session?.date_start);
        const end = parseIso(session?.date_end || session?.date_start);
        if (!start || !end || !now)
            return false;
        return now.compare(start) >= 0 && now.compare(end) <= 0;
    }

    async _loadDriverDirectoryForSession(sessionKey) {
        try {
            const res = await this._fetchJsonCached(`drivers?session_key=${sessionKey}`, RESULT_CACHE_SECONDS);
            const map = {};
            for (const d of res.data || []) {
                const dn = d.driver_number;
                if (dn === null || dn === undefined)
                    continue;
                const dkey = String(dn);
                map[dkey] = {
                    name: d.full_name || d.broadcast_name || d.last_name || `#${dn}`,
                    team: d.team_name || d.team_colour || 'Unknown Team',
                };
            }
            return map;
        } catch (_e) {
            return {};
        }
    }

    _updateCalendar(meetings, sessions) {
        const now = parseIso(isoNow());
        if (!meetings?.length || !sessions?.length) {
            this._setSectionMessage(this._calendarContent, 'No schedule data');
            this._label.text = 'F1 | -';
            return;
        }

        const byMeeting = new Map();
        for (const session of sessions) {
            if (!byMeeting.has(session.meeting_key))
                byMeeting.set(session.meeting_key, []);
            byMeeting.get(session.meeting_key).push(session);
        }

        for (const list of byMeeting.values())
            list.sort((a, b) => parseIso(a.date_start).to_unix() - parseIso(b.date_start).to_unix());

        let selectedMeeting = null;
        let selectedMeetingSessions = [];
        let nextSession = null;

        const sortedMeetings = [...meetings].sort((a, b) => parseIso(a.date_start).to_unix() - parseIso(b.date_start).to_unix());

        // Primary selection (same strategy as macOS widget):
        // - first upcoming meeting
        // - or current active meeting window
        for (const meeting of sortedMeetings) {
            const mStart = parseIso(meeting.date_start);
            const mEnd = parseIso(meeting.date_end);
            const mSessions = byMeeting.get(meeting.meeting_key) || [];
            const activeSessions = mSessions.filter(s => !s.is_cancelled);

            if (!activeSessions.length)
                continue;

            if (now.compare(mStart) < 0) {
                selectedMeeting = meeting;
                selectedMeetingSessions = activeSessions;
                nextSession = activeSessions[0] || null;
                break;
            }

            if (now.compare(mStart) >= 0 && now.compare(mEnd) <= 0) {
                selectedMeeting = meeting;
                selectedMeetingSessions = activeSessions;
                nextSession = activeSessions.find(s => now.compare(parseIso(s.date_start)) < 0) || null;
                break;
            }
        }

        // Fallback 1: if no active window matched, pick first upcoming non-cancelled meeting.
        if (!selectedMeeting) {
            for (const meeting of sortedMeetings) {
                const mStart = parseIso(meeting.date_start);
                const mSessions = byMeeting.get(meeting.meeting_key) || [];
                const activeSessions = mSessions.filter(s => !s.is_cancelled);
                if (!activeSessions.length)
                    continue;
                if (now.compare(mStart) < 0) {
                    selectedMeeting = meeting;
                    selectedMeetingSessions = activeSessions;
                    nextSession = activeSessions[0] || null;
                    break;
                }
            }
        }

        // Fallback 2: final fallback to latest non-cancelled meeting (show completed weekend context).
        if (!selectedMeeting) {
            for (let i = sortedMeetings.length - 1; i >= 0; i--) {
                const meeting = sortedMeetings[i];
                const mSessions = byMeeting.get(meeting.meeting_key) || [];
                const activeSessions = mSessions.filter(s => !s.is_cancelled);
                if (!activeSessions.length)
                    continue;
                selectedMeeting = meeting;
                selectedMeetingSessions = activeSessions;
                nextSession = activeSessions.find(s => now.compare(parseIso(s.date_start)) < 0) || null;
                break;
            }
        }

        if (!selectedMeeting) {
            this._setSectionMessage(this._calendarContent, 'No upcoming weekend this season');
            this._label.text = 'F1 | DONE';
            this._hasCalendarData = true;
            return;
        }

        const countryCode = countryCodeLabel(selectedMeeting.country_code);
        const meetingOffset = selectedMeeting.gmt_offset || null;

        const liveSession = selectedMeetingSessions.find(s => this._isSessionLive(s, now)) || null;

        const rows = [
            {text: `Grand Prix: ${selectedMeeting.meeting_name} (${countryCode})`},
            {text: `Location: ${selectedMeeting.location || 'N/A'}`, dim: true},
            {text: `Weekend: ${formatCompactOffset(selectedMeeting.date_start, meetingOffset)} → ${formatCompactOffset(selectedMeeting.date_end, meetingOffset)}`, dim: true},
            {text: `Last updated: ${formatUpdatedTs(this._cache.meta?.lastRefreshTs || 0)} (${this._cache.meta?.lastRefreshSource || 'CACHE'})`, dim: true},
            {text: liveSession
                ? `LIVE now: ${abbreviateSessionName(liveSession.session_name)} (${formatCompactOffset(liveSession.date_start, meetingOffset)} → ${formatCompactOffset(liveSession.date_end || liveSession.date_start, meetingOffset)})`
                : 'Sessions (System/UTC/Local):', dim: true},
        ];

        const sessionLimit = 8;
        const shownSessions = selectedMeetingSessions.slice(0, sessionLimit);
        for (const s of shownSessions) {
            const isLive = liveSession && s.session_key === liveSession.session_key;
            const isNext = !isLive && nextSession && s.session_key === nextSession.session_key;
            const marker = isLive ? 'LIVE' : (isNext ? 'NEXT' : '-');
            const short = abbreviateSessionName(s.session_name);
            rows.push({
                text: `${marker} ${short}: ${formatCompactTz(s.date_start, 'local')} / ${formatCompactTz(s.date_start, 'utc')} / ${formatCompactOffset(s.date_start, meetingOffset)}`,
            });
        }

        if (selectedMeetingSessions.length > sessionLimit)
            rows.push({text: `… ${selectedMeetingSessions.length - sessionLimit} more sessions`, dim: true});

        if (!selectedMeetingSessions.length)
            rows.push({text: 'No session schedule found for this meeting', dim: true});

        if (liveSession)
            this._label.text = `F1 | LIVE ${abbreviateSessionName(liveSession.session_name)}`;
        else if (nextSession)
            this._label.text = `F1 | ${abbreviateSessionName(nextSession.session_name)}`;
        else
            this._label.text = 'F1 | done';

        this._setRows(this._calendarContent, rows);
        this._cache.ui.calendarRows = rows;
        this._cache.ui.panelLabel = this._label.text;
        this._hasCalendarData = true;
    }

    async _buildStandings(sessions) {
        let apiUsed = false;
        const raceLikeSessions = sessions.filter(s => {
            const n = (s.session_name || '').toLowerCase();
            const t = (s.session_type || '').toLowerCase();
            return n === 'race' || n.includes('sprint') || t === 'race' || t.includes('sprint');
        }).sort((a, b) => parseIso(a.date_start).to_unix() - parseIso(b.date_start).to_unix());

        const now = parseIso(isoNow());
        const completed = raceLikeSessions.filter(s => !s.is_cancelled && now.compare(parseIso(s.date_end || s.date_start)) >= 0);

        if (completed.length === 0)
            return {drivers: [], teams: [], source: 'CACHE'};

        const latestCompleted = completed[completed.length - 1];
        const latestDirectory = await this._loadDriverDirectoryForSession(latestCompleted.session_key);

        if (!this._cache.standings)
            this._cache.standings = {sessionPoints: {}, driverInfo: {}};
        if (!this._cache.standings.sessionPoints)
            this._cache.standings.sessionPoints = {};
        if (!this._cache.standings.driverInfo)
            this._cache.standings.driverInfo = {};

        const cachedSessionPoints = this._cache.standings.sessionPoints;
        const cachedDriverInfo = this._cache.standings.driverInfo;

        for (const s of completed) {
            const sk = String(s.session_key);
            if (cachedSessionPoints[sk])
                continue;

            const sessionEnd = parseIso(s.date_end || s.date_start);
            const isCompletedPast = sessionEnd && (unixNow() - sessionEnd.to_unix()) > (2 * 60 * 60);
            const cacheAge = isCompletedPast ? RESULT_CACHE_SECONDS : REFRESH_WEEKEND_SECONDS;

            let res;
            try {
                res = await this._fetchJsonCached(`session_result?session_key=${s.session_key}`, cacheAge);
                apiUsed = apiUsed || res.source === 'API';
            } catch (e) {
                const msg = String(e?.message || e);
                if (msg.includes('404') && msg.toLowerCase().includes('no results found')) {
                    // mark session as processed with empty result to avoid repeated failing fetches
                    cachedSessionPoints[sk] = {};
                    continue;
                }
                throw e;
            }

            const driverDirectory = await this._loadDriverDirectoryForSession(s.session_key);
            const perSession = {};
            for (const r of res.data) {
                const dn = r.driver_number;
                if (dn === null || dn === undefined)
                    continue;

                const pts = Number(r.points || 0);
                if (!Number.isFinite(pts))
                    continue;

                const dkey = String(dn);
                perSession[dkey] = (perSession[dkey] || 0) + pts;

                const dirInfo = driverDirectory[dkey] || {};
                const name = r.full_name || r.broadcast_name || dirInfo.name || `#${dn}`;
                const team = r.team_name || dirInfo.team || 'Unknown Team';

                if (!cachedDriverInfo[dkey]) {
                    cachedDriverInfo[dkey] = {name, team};
                } else {
                    // Prefer richer values over placeholders
                    if ((cachedDriverInfo[dkey].name || '').startsWith('#') && name)
                        cachedDriverInfo[dkey].name = name;
                    if (cachedDriverInfo[dkey].team === 'Unknown Team' && team)
                        cachedDriverInfo[dkey].team = team;
                }
            }
            cachedSessionPoints[sk] = perSession;
        }

        for (const [dkey, info] of Object.entries(latestDirectory)) {
            if (!cachedDriverInfo[dkey]) {
                cachedDriverInfo[dkey] = info;
                continue;
            }
            if ((cachedDriverInfo[dkey].name || '').startsWith('#') && info.name)
                cachedDriverInfo[dkey].name = info.name;
            if (cachedDriverInfo[dkey].team === 'Unknown Team' && info.team)
                cachedDriverInfo[dkey].team = info.team;
        }

        const pointsByDriver = new Map();
        for (const s of completed) {
            const sk = String(s.session_key);
            const perSession = cachedSessionPoints[sk] || {};
            for (const [dkey, pts] of Object.entries(perSession)) {
                pointsByDriver.set(dkey, (pointsByDriver.get(dkey) || 0) + Number(pts || 0));
            }
        }

        if (pointsByDriver.size === 0)
            return {drivers: [], teams: [], source: apiUsed ? 'API' : 'CACHE'};

        const teamPoints = new Map();
        const drivers = [...pointsByDriver.entries()]
            .map(([driverNumber, points]) => {
                const info = cachedDriverInfo[driverNumber] || {name: `#${driverNumber}`, team: 'Unknown Team'};
                teamPoints.set(info.team, (teamPoints.get(info.team) || 0) + points);
                return {
                    driverNumber,
                    points,
                    name: info.name,
                    team: info.team,
                };
            })
            .sort((a, b) => b.points - a.points)
            .map((d, idx) => ({...d, rank: idx + 1}));

        const teams = [...teamPoints.entries()]
            .map(([team, points]) => ({team, points}))
            .sort((a, b) => b.points - a.points)
            .map((t, idx) => ({...t, rank: idx + 1}));

        return {drivers, teams, source: apiUsed ? 'API' : 'CACHE'};
    }

    _updateStandings({drivers, teams}) {
        if (!drivers.length) {
            this._setSectionMessage(this._driversContent, 'No completed race results yet');
            this._hasStandingsData = true;
            return;
        }

        const topDrivers = drivers.slice(0, 10);
        const topTeams = teams.slice(0, 10);

        const rows = [];
        rows.push({text: 'Drivers', dim: true});
        for (const d of topDrivers)
            rows.push(`${d.rank}. ${d.name} — ${d.points}p`);

        rows.push({text: 'Teams', dim: true});
        for (const t of topTeams)
            rows.push(`${t.rank}. ${t.team} — ${t.points}p`);

        this._setRows(this._driversContent, rows);
        this._cache.ui.driverRows = rows;
        this._cache.ui.teamRows = topTeams;
        this._hasStandingsData = true;
    }
}

export default class OpenF1DashboardExtension extends Extension {
    enable() {
        this._indicator = new OpenF1Indicator(BUILD_VERSION);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        _unknownCountryCodesLogged.clear();
    }
}
