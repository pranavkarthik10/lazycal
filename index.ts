#!/usr/bin/env bun

import {
  createCliRenderer,
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
} from "@opentui/core"
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  getDate,
  getDay,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns"
import { access, mkdir, readFile, writeFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"
import { createInterface } from "readline/promises"
import { GoogleCalendarClient, generateSampleEvents, type CalendarEvent } from "./google-calendar"

const COLORS = {
  bg: "#1E1E1E",
  fg: "#E2E8F0",
  headerBg: "#2D3748",
  headerFg: "#F7FAFC",
  dayHeaderBg: "#4A5568",
  dayHeaderFg: "#CBD5E0",
  selectedBg: "#3182CE",
  selectedFg: "#FFFFFF",
  todayBg: "#2C5282",
  todayFg: "#FFFFFF",
  otherMonthFg: "#718096",
  weekendBg: "#2D3748",
  border: "#4A5568",
  eventDot: "#48BB78",
  scrollBg: "#2D3748",
  scrollThumb: "#4A5568",
  overlayBg: "#0F172A",
  synced: "#48BB78",
  offline: "#F6AD55",
  timeColumn: "#1A202C",
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const TIME_COLUMN_WIDTH = 7
const TIME_GRID_ROW_HEIGHT = 3
const CONFIG_DIR = join(homedir(), ".config", "lazycal")
const CREDENTIALS_PATH = join(CONFIG_DIR, "credentials.json")
const UI_STATE_PATH = join(CONFIG_DIR, "ui-state.json")

type ViewMode = "day" | "week" | "month"

interface CalendarConfig {
  id: string
  name: string
  color: string
  enabled: boolean
}

interface DateRange {
  start: Date
  end: Date
}

interface LayoutConfig {
  terminalWidth: number
  showSidebar: boolean
  sidebarWidth: number
  visibleDayCount: number
}

interface UiState {
  disabledCalendarIds: string[]
}

class GoogleCalendarTUI {
  private renderer!: Awaited<ReturnType<typeof createCliRenderer>>
  private currentDate: Date
  private selectedDate: Date
  private weekStart: Date
  private viewMode: ViewMode = "week"
  private events: CalendarEvent[]
  private loadedRange: DateRange | null = null
  private googleClient: GoogleCalendarClient
  private isGoogleConnected = false
  private calendars: CalendarConfig[] = []
  private selectedCalendarIds: string[] = []
  private rootBox: BoxRenderable | null = null
  private eventsScrollBox: ScrollBoxRenderable | null = null
  private eventsBox: BoxRenderable | null = null
  private resizeHandler: (() => void) | null = null
  private sidebarEnabled = true

  constructor() {
    this.currentDate = new Date()
    this.selectedDate = new Date()
    this.weekStart = startOfWeek(this.selectedDate, { weekStartsOn: 0 })
    this.events = generateSampleEvents()
    this.googleClient = new GoogleCalendarClient()
  }

  async init() {
    console.log("Checking for Google Calendar credentials...")
    this.isGoogleConnected = await this.googleClient.initialize()

    if (!this.isGoogleConnected) {
      const ranSetupOnboarding = await this.maybeRunCredentialOnboarding()
      if (ranSetupOnboarding) {
        console.log("\nRe-checking Google Calendar credentials...")
        this.isGoogleConnected = await this.googleClient.initialize()
      }
    }

    if (this.isGoogleConnected) {
      await this.loadCalendarsAndEvents()
    } else {
      console.log("Using sample data. Add credentials to use real Google Calendar.")
    }

    this.renderer = await createCliRenderer({
      exitOnCtrlC: true,
      targetFps: 30,
    })

    this.renderer.setBackgroundColor(COLORS.bg)
    this.setupKeyboardHandling()
    this.setupResizeHandling()
    this.createLayout()
    this.renderer.requestRender()
  }

  private async loadCalendarsAndEvents() {
    console.log("Connected to Google Calendar!")
    const availableCalendars = await this.googleClient.listCalendars()
    const uiState = await this.loadUiState()
    const disabledCalendarIds = new Set(uiState?.disabledCalendarIds || [])

    this.calendars = availableCalendars.map((calendar, index) => ({
      id: calendar.id,
      name: calendar.name,
      color: ["#4285F4", "#EA4335", "#FBBC04", "#34A853", "#9AA0A6", "#673AB7"][index % 6],
      enabled: !disabledCalendarIds.has(calendar.id),
    }))

    if (this.calendars.length > 0 && this.calendars.every(calendar => !calendar.enabled)) {
      this.calendars.forEach(calendar => {
        calendar.enabled = true
      })
    }

    this.selectedCalendarIds = this.calendars.map(calendar => calendar.id)
      .filter(calendarId => this.calendars.some(calendar => calendar.id === calendarId && calendar.enabled))

    console.log(`Found ${this.calendars.length} calendars`)
    await this.loadEventsIfNeeded(true)
  }

  private async credentialsExist(): Promise<boolean> {
    try {
      await access(CREDENTIALS_PATH)
      return true
    } catch {
      return false
    }
  }

  private async maybeRunCredentialOnboarding(): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false

    const hasCredentials = await this.credentialsExist()
    if (hasCredentials) return false

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    try {
      const answer = await rl.question("Start built-in Google Calendar setup now? [Y/n]: ")
      const wantsSetup = answer.trim() === "" || answer.trim().toLowerCase().startsWith("y")
      if (!wantsSetup) return false

      console.log("\nGoogle Calendar setup:")
      console.log("1) Open https://console.cloud.google.com/")
      console.log("2) Enable Google Calendar API")
      console.log("3) Create OAuth 2.0 Client ID (Desktop app)")
      console.log(`4) Save downloaded JSON to: ${CREDENTIALS_PATH}`)
      console.log("5) Press Enter below when done")

      while (true) {
        const confirm = await rl.question("Press Enter when ready, or type 'skip' to continue with sample data: ")
        if (confirm.trim().toLowerCase() === "skip") {
          return false
        }

        if (await this.credentialsExist()) {
          console.log("credentials.json detected.")
          return true
        }

        console.log(`credentials.json not found at ${CREDENTIALS_PATH}`)
      }
    } finally {
      rl.close()
    }
  }

  private parseUiState(content: string): UiState | null {
    try {
      const parsed = JSON.parse(content) as { disabledCalendarIds?: unknown }
      if (!Array.isArray(parsed.disabledCalendarIds)) {
        return { disabledCalendarIds: [] }
      }

      const disabledCalendarIds = parsed.disabledCalendarIds.filter(
        (calendarId): calendarId is string => typeof calendarId === "string"
      )
      return { disabledCalendarIds }
    } catch {
      return null
    }
  }

  private async loadUiState(): Promise<UiState | null> {
    try {
      const content = await readFile(UI_STATE_PATH, "utf-8")
      return this.parseUiState(content)
    } catch {
      return null
    }
  }

  private async persistUiState() {
    const disabledCalendarIds = this.calendars
      .filter(calendar => !calendar.enabled)
      .map(calendar => calendar.id)

    try {
      await mkdir(CONFIG_DIR, { recursive: true })
      await writeFile(
        UI_STATE_PATH,
        JSON.stringify({ disabledCalendarIds } satisfies UiState, null, 2),
        "utf-8"
      )
    } catch (error) {
      console.error("Unable to save UI state:", error)
    }
  }

  private setupResizeHandling() {
    this.resizeHandler = () => {
      void this.refreshCalendar()
    }
    process.stdout.on("resize", this.resizeHandler)
  }

  private getWeekDays(): Date[] {
    return Array.from({ length: 7 }, (_, index) => addDays(this.weekStart, index))
  }

  private getEventsForDate(date: Date): CalendarEvent[] {
    return this.events.filter(event => isSameDay(event.date, date))
  }

  private parseEventHour(timeValue: string): number | null {
    const normalized = timeValue.replace(/\u202F/g, " ").trim()
    const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?(?:\s*([AP]M))?$/i)
    if (!match) return null

    let hour = Number.parseInt(match[1] || "", 10)
    if (!Number.isFinite(hour)) return null

    const meridiem = (match[3] || "").toUpperCase()
    if (meridiem === "PM" && hour < 12) hour += 12
    if (meridiem === "AM" && hour === 12) hour = 0
    if (hour < 0 || hour > 23) return null

    return hour
  }

  private getEventsForHour(date: Date, hour: number): CalendarEvent[] {
    return this.events.filter(event => {
      if (!isSameDay(event.date, date) || !event.time) return false
      const eventHour = this.parseEventHour(event.time)
      return eventHour !== null && eventHour === hour
    })
  }

  private getGridEventColor(daySelected: boolean, dayIsToday: boolean, calendarColor: string | undefined): string {
    if (daySelected || dayIsToday) return COLORS.selectedFg
    if (!calendarColor) return COLORS.eventDot
    if (calendarColor.toLowerCase() === COLORS.bg.toLowerCase()) return COLORS.eventDot
    return calendarColor
  }

  private getGridEventLabelMaxLength(layout: LayoutConfig, visibleDayCount: number): number {
    const reserved = layout.showSidebar ? layout.sidebarWidth + 2 : 2
    const gridWidth = Math.max(20, layout.terminalWidth - reserved)
    const gapWidth = visibleDayCount
    const dayColumnsWidth = Math.max(8, gridWidth - TIME_COLUMN_WIDTH - gapWidth)
    const perDayWidth = Math.max(8, Math.floor(dayColumnsWidth / Math.max(1, visibleDayCount)))
    return Math.max(8, perDayWidth - 2)
  }

  private getCurrentRangeForView(): DateRange {
    if (this.viewMode === "day") {
      const dayStart = new Date(this.selectedDate)
      dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(this.selectedDate)
      dayEnd.setHours(23, 59, 59, 999)
      return { start: dayStart, end: dayEnd }
    }

    if (this.viewMode === "week") {
      const start = startOfWeek(this.selectedDate, { weekStartsOn: 0 })
      const end = endOfWeek(this.selectedDate, { weekStartsOn: 0 })
      return { start, end }
    }

    const monthStart = startOfMonth(this.currentDate)
    const monthEnd = endOfMonth(this.currentDate)
    return {
      start: startOfWeek(monthStart, { weekStartsOn: 0 }),
      end: endOfWeek(monthEnd, { weekStartsOn: 0 }),
    }
  }

  private rangeContains(container: DateRange, target: DateRange): boolean {
    return container.start.getTime() <= target.start.getTime() && container.end.getTime() >= target.end.getTime()
  }

  private async loadEventsIfNeeded(forceFetch = false) {
    if (!this.isGoogleConnected) return
    const requestedRange = this.getCurrentRangeForView()

    if (!forceFetch && this.loadedRange && this.rangeContains(this.loadedRange, requestedRange)) {
      return
    }

    this.events = await this.googleClient.fetchEventsFromCalendars(this.selectedDate, this.selectedCalendarIds, requestedRange)
    this.loadedRange = requestedRange
  }

  private getSidebarWidth(terminalWidth: number): number {
    if (terminalWidth >= 175) return 42
    if (terminalWidth >= 145) return 36
    if (terminalWidth >= 120) return 32
    return 28
  }

  private calculateVisibleDayCount(terminalWidth: number, sidebarWidth: number): number {
    if (this.viewMode === "day") return 1

    const reserved = sidebarWidth > 0 ? sidebarWidth + 2 : 2
    const gridWidth = Math.max(20, terminalWidth - reserved)
    const baseOffset = this.viewMode === "month" ? 0 : TIME_COLUMN_WIDTH + 1
    const minCellWidth = this.viewMode === "month" ? 10 : 11
    const count = Math.floor((gridWidth - baseOffset) / (minCellWidth + 1))
    return Math.max(1, Math.min(7, count))
  }

  private getLayoutConfig(): LayoutConfig {
    const terminalWidth = Math.max(80, process.stdout.columns || 120)
    let showSidebar = this.sidebarEnabled && terminalWidth >= 104
    let sidebarWidth = showSidebar ? this.getSidebarWidth(terminalWidth) : 0
    let visibleDayCount = this.calculateVisibleDayCount(terminalWidth, sidebarWidth)

    if (showSidebar && this.viewMode !== "day" && visibleDayCount < 3) {
      showSidebar = false
      sidebarWidth = 0
      visibleDayCount = this.calculateVisibleDayCount(terminalWidth, 0)
    }

    return {
      terminalWidth,
      showSidebar,
      sidebarWidth,
      visibleDayCount,
    }
  }

  private getVisibleDays(layout: LayoutConfig): Date[] {
    if (this.viewMode === "day") return [this.selectedDate]

    const weekDays = this.getWeekDays()
    if (layout.visibleDayCount >= 7) return weekDays

    const selectedIndex = Math.max(0, Math.min(6, differenceInCalendarDays(this.selectedDate, this.weekStart)))
    const halfWindow = Math.floor((layout.visibleDayCount - 1) / 2)
    const windowStart = Math.max(0, Math.min(selectedIndex - halfWindow, 7 - layout.visibleDayCount))

    return weekDays.slice(windowStart, windowStart + layout.visibleDayCount)
  }

  private getVisibleMonthDayIndices(layout: LayoutConfig): number[] {
    if (layout.visibleDayCount >= 7) return [0, 1, 2, 3, 4, 5, 6]
    const selectedDow = getDay(this.selectedDate)
    const halfWindow = Math.floor((layout.visibleDayCount - 1) / 2)
    const start = Math.max(0, Math.min(selectedDow - halfWindow, 7 - layout.visibleDayCount))
    return Array.from({ length: layout.visibleDayCount }, (_, i) => start + i)
  }

  private buildHeaderTitle(layout: LayoutConfig): string {
    let dateText: string
    if (this.viewMode === "day") {
      dateText = format(this.selectedDate, "EEEE, MMM d, yyyy")
    } else if (this.viewMode === "week") {
      const weekDays = this.getWeekDays()
      dateText = `${format(weekDays[0], "MMM d")} - ${format(weekDays[6], "MMM d, yyyy")}`
    } else {
      dateText = format(this.currentDate, "MMMM yyyy")
    }

    const modeText = `mode:${this.viewMode}`
    const statusText = this.isGoogleConnected
      ? `google:${this.calendars.filter(calendar => calendar.enabled).length}/${this.calendars.length}`
      : "sample-data"

    const widthText = this.viewMode === "day" ? "" : ` days:${layout.visibleDayCount}/7`
    return this.truncate(`${dateText}  ${modeText}  ${statusText}${widthText}`, layout.terminalWidth - 4)
  }

  private buildCommandHint(layout: LayoutConfig): string {
    const full = "keys: d/w/m view  left/right day  up/down week  h/l month  t today  ? help  q quit"
    const compact = "keys: d/w/m left/right up/down h/l t ? q"
    return this.truncate(layout.terminalWidth >= 132 ? full : compact, layout.terminalWidth - 4)
  }

  private createLayout() {
    const layout = this.getLayoutConfig()

    this.rootBox = new BoxRenderable(this.renderer, {
      id: "root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: COLORS.bg,
    })
    this.renderer.root.add(this.rootBox)

    const headerBox = new BoxRenderable(this.renderer, {
      id: "header",
      height: 3,
      flexShrink: 0,
      flexDirection: "column",
      backgroundColor: COLORS.headerBg,
      paddingLeft: 1,
      paddingRight: 1,
      justifyContent: "flex-start",
    })
    this.rootBox.add(headerBox)

    const titleText = new TextRenderable(this.renderer, {
      id: "header-title",
      content: this.buildHeaderTitle(layout),
      fg: COLORS.headerFg,
      alignSelf: "center",
      marginBottom: 1,
    })
    headerBox.add(titleText)

    const commandHint = new TextRenderable(this.renderer, {
      id: "header-command-hint",
      content: this.buildCommandHint(layout),
      fg: COLORS.dayHeaderFg,
      alignSelf: "center",
    })
    headerBox.add(commandHint)

    const contentBox = new BoxRenderable(this.renderer, {
      id: "content",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
      paddingLeft: 1,
      paddingRight: 1,
      paddingBottom: 1,
      paddingTop: 0,
    })
    this.rootBox.add(contentBox)

    const calendarContainer = new BoxRenderable(this.renderer, {
      id: "calendar-container",
      flexGrow: 1,
      flexDirection: "column",
      minWidth: 30,
    })
    contentBox.add(calendarContainer)

    if (this.viewMode === "month") {
      this.createMonthGrid(calendarContainer, layout)
    } else {
      this.createTimeGrid(calendarContainer, layout)
    }

    if (layout.showSidebar) {
      this.createEventsSidebar(contentBox, layout.sidebarWidth)
    } else {
      this.eventsBox = null
      this.eventsScrollBox = null
    }
  }

  private createTimeGrid(container: BoxRenderable, layout: LayoutConfig) {
    const visibleDays = this.getVisibleDays(layout)
    const maxEventLabelLength = this.getGridEventLabelMaxLength(layout, visibleDays.length)

    const headerRow = new BoxRenderable(this.renderer, {
      id: "time-grid-header-row",
      height: 3,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
      marginBottom: 1,
    })
    container.add(headerRow)

    const timeHeader = new BoxRenderable(this.renderer, {
      id: "time-grid-header-time",
      width: TIME_COLUMN_WIDTH,
      height: 3,
      flexShrink: 0,
      backgroundColor: COLORS.timeColumn,
      border: true,
      borderStyle: "single",
      borderColor: COLORS.border,
      justifyContent: "center",
      alignItems: "center",
    })
    const timeText = new TextRenderable(this.renderer, {
      id: "time-grid-header-time-text",
      content: "Time",
      fg: COLORS.otherMonthFg,
    })
    timeHeader.add(timeText)
    headerRow.add(timeHeader)

    visibleDays.forEach((day, index) => {
      const selected = isSameDay(day, this.selectedDate)
      const today = isToday(day)
      const weekend = getDay(day) === 0 || getDay(day) === 6
      const dayHeader = new BoxRenderable(this.renderer, {
        id: `time-grid-day-header-${index}`,
        flexGrow: 1,
        flexBasis: 0,
        height: 3,
        backgroundColor: selected
          ? COLORS.selectedBg
          : today
            ? COLORS.todayBg
            : weekend
              ? COLORS.weekendBg
              : COLORS.dayHeaderBg,
        border: true,
        borderStyle: selected || today ? "double" : "single",
        borderColor: selected ? COLORS.selectedFg : today ? COLORS.todayFg : COLORS.border,
        justifyContent: "center",
        alignItems: "center",
      })

      const headerText = new TextRenderable(this.renderer, {
        id: `time-grid-day-header-text-${index}`,
        content: `${format(day, "EEE")} ${getDate(day)}`,
        fg: selected || today ? COLORS.selectedFg : COLORS.dayHeaderFg,
      })
      dayHeader.add(headerText)
      headerRow.add(dayHeader)
    })

    const hoursScroll = new ScrollBoxRenderable(this.renderer, {
      id: "time-grid-hours-scroll",
      flexGrow: 1,
      backgroundColor: "transparent",
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: COLORS.scrollThumb,
          backgroundColor: COLORS.scrollBg,
        },
      },
    })
    container.add(hoursScroll)

    HOURS.forEach(hour => {
      const hourRow = new BoxRenderable(this.renderer, {
        id: `time-grid-hour-row-${hour}`,
        height: TIME_GRID_ROW_HEIGHT,
        width: "100%",
        flexShrink: 0,
        flexDirection: "row",
        gap: 1,
      })

      const timeLabel = new BoxRenderable(this.renderer, {
        id: `time-grid-hour-label-${hour}`,
        width: TIME_COLUMN_WIDTH,
        height: TIME_GRID_ROW_HEIGHT,
        flexShrink: 0,
        backgroundColor: COLORS.timeColumn,
        border: true,
        borderStyle: "single",
        borderColor: COLORS.border,
        justifyContent: "center",
      })
      const labelText = new TextRenderable(this.renderer, {
        id: `time-grid-hour-label-text-${hour}`,
        content: `${hour.toString().padStart(2, "0")}:00`,
        fg: COLORS.otherMonthFg,
        alignSelf: "center",
      })
      timeLabel.add(labelText)
      hourRow.add(timeLabel)

      visibleDays.forEach((day, dayIndex) => {
        const selected = isSameDay(day, this.selectedDate)
        const today = isToday(day)
        const weekend = getDay(day) === 0 || getDay(day) === 6
        const hourEvents = this.getEventsForHour(day, hour)
        const firstEvent = hourEvents[0]
        const calendarColor = firstEvent
          ? this.calendars.find(calendar => calendar.id === firstEvent.calendarId)?.color
          : undefined
        const eventColor = this.getGridEventColor(selected, today, calendarColor)
        const eventText = firstEvent
          ? this.truncate(
              `• ${firstEvent.title}${hourEvents.length > 1 ? ` +${hourEvents.length - 1}` : ""}`,
              maxEventLabelLength
            )
          : ""

        const dayCell = new BoxRenderable(this.renderer, {
          id: `time-grid-day-cell-${hour}-${dayIndex}`,
          flexGrow: 1,
          flexBasis: 0,
          height: TIME_GRID_ROW_HEIGHT,
          backgroundColor: selected ? COLORS.selectedBg : today ? COLORS.todayBg : weekend ? COLORS.weekendBg : COLORS.bg,
          border: true,
          borderStyle: "single",
          borderColor: selected ? COLORS.selectedFg : COLORS.border,
          paddingLeft: 0,
          paddingRight: 0,
          overflow: "hidden",
        })

        if (eventText) {
          const eventLabel = new TextRenderable(this.renderer, {
            id: `time-grid-event-label-${hour}-${dayIndex}`,
            content: eventText,
            fg: eventColor,
            marginLeft: 0,
          })
          dayCell.add(eventLabel)
        }

        hourRow.add(dayCell)
      })

      hoursScroll.add(hourRow)
    })

    const currentHour = new Date().getHours()
    const visibleStartHour = HOURS[0] ?? 0
    const hourOffset = Math.max(0, currentHour - visibleStartHour - 1)
    setTimeout(() => {
      hoursScroll.scrollTo({ x: 0, y: hourOffset * TIME_GRID_ROW_HEIGHT })
    }, 100)
  }

  private createMonthGrid(container: BoxRenderable, layout: LayoutConfig) {
    const visibleDayIndices = this.getVisibleMonthDayIndices(layout)

    const weekdayHeader = new BoxRenderable(this.renderer, {
      id: "month-weekday-header",
      height: 3,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
      marginBottom: 1,
    })
    container.add(weekdayHeader)

    visibleDayIndices.forEach((dayIndex, index) => {
      const dayName = format(addDays(startOfWeek(new Date(), { weekStartsOn: 0 }), dayIndex), "EEE")
      const headerCell = new BoxRenderable(this.renderer, {
        id: `month-weekday-header-cell-${index}`,
        flexGrow: 1,
        flexBasis: 0,
        height: 3,
        border: true,
        borderStyle: "single",
        borderColor: COLORS.border,
        backgroundColor: dayIndex === 0 || dayIndex === 6 ? COLORS.weekendBg : COLORS.dayHeaderBg,
        justifyContent: "center",
        alignItems: "center",
      })
      const text = new TextRenderable(this.renderer, {
        id: `month-weekday-header-text-${index}`,
        content: dayName,
        fg: COLORS.dayHeaderFg,
      })
      headerCell.add(text)
      weekdayHeader.add(headerCell)
    })

    const monthScroll = new ScrollBoxRenderable(this.renderer, {
      id: "month-grid-scroll",
      flexGrow: 1,
      backgroundColor: "transparent",
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: COLORS.scrollThumb,
          backgroundColor: COLORS.scrollBg,
        },
      },
    })
    container.add(monthScroll)

    const gridStart = startOfWeek(startOfMonth(this.currentDate), { weekStartsOn: 0 })
    const gridEnd = endOfWeek(endOfMonth(this.currentDate), { weekStartsOn: 0 })
    const totalDays = differenceInCalendarDays(gridEnd, gridStart) + 1
    const rows = Math.max(1, Math.ceil(totalDays / 7))

    for (let row = 0; row < rows; row++) {
      const weekRow = new BoxRenderable(this.renderer, {
        id: `month-week-row-${row}`,
        height: 5,
        flexShrink: 0,
        flexDirection: "row",
        gap: 1,
        marginBottom: 1,
      })

      visibleDayIndices.forEach((dow, index) => {
        const day = addDays(gridStart, row * 7 + dow)
        const inMonth = isSameMonth(day, this.currentDate)
        const selected = isSameDay(day, this.selectedDate)
        const today = isToday(day)
        const dayEvents = this.getEventsForDate(day).slice(0, 2)

        const cell = new BoxRenderable(this.renderer, {
          id: `month-day-cell-${row}-${index}`,
          flexGrow: 1,
          flexBasis: 0,
          height: 5,
          border: true,
          borderStyle: selected || today ? "double" : "single",
          borderColor: selected ? COLORS.selectedFg : today ? COLORS.todayFg : COLORS.border,
          backgroundColor: selected ? COLORS.selectedBg : inMonth ? COLORS.bg : COLORS.weekendBg,
          overflow: "hidden",
          paddingLeft: 0,
          paddingRight: 0,
        })

        const numberText = new TextRenderable(this.renderer, {
          id: `month-day-number-${row}-${index}`,
          content: String(getDate(day)),
          fg: selected ? COLORS.selectedFg : inMonth ? COLORS.fg : COLORS.otherMonthFg,
        })
        cell.add(numberText)

        dayEvents.forEach((event, eventIndex) => {
          const color = this.calendars.find(calendar => calendar.id === event.calendarId)?.color || COLORS.eventDot
          const eventLine = new TextRenderable(this.renderer, {
            id: `month-day-event-${row}-${index}-${eventIndex}`,
            content: this.truncate(event.title, 12),
            fg: color,
            marginTop: 0,
          })
          cell.add(eventLine)
        })

        weekRow.add(cell)
      })

      monthScroll.add(weekRow)
    }
  }

  private createEventsSidebar(contentBox: BoxRenderable, sidebarWidth: number) {
    this.eventsBox = new BoxRenderable(this.renderer, {
      id: "events-box",
      width: sidebarWidth,
      flexShrink: 0,
      flexDirection: "column",
      border: true,
      borderStyle: "single",
      borderColor: COLORS.border,
      backgroundColor: COLORS.headerBg,
      padding: 1,
    })
    contentBox.add(this.eventsBox)

    const selectedDateHeader = new TextRenderable(this.renderer, {
      id: "selected-date-header",
      content: format(this.selectedDate, "EEEE, MMM d"),
      fg: COLORS.headerFg,
      marginBottom: 1,
    })
    this.eventsBox.add(selectedDateHeader)

    const allDayEvents = this.getEventsForDate(this.selectedDate).filter(event => !event.time)
    if (allDayEvents.length > 0) {
      const allDayHeader = new TextRenderable(this.renderer, {
        id: "allday-header",
        content: "All Day",
        fg: COLORS.otherMonthFg,
      })
      this.eventsBox.add(allDayHeader)

      allDayEvents.forEach((event, index) => {
        const color = this.calendars.find(calendar => calendar.id === event.calendarId)?.color || COLORS.eventDot
        const eventBox = new BoxRenderable(this.renderer, {
          id: `allday-event-${index}`,
          width: "100%",
          flexShrink: 0,
          backgroundColor: COLORS.bg,
          padding: 1,
          marginBottom: 1,
          border: true,
          borderStyle: "single",
          borderColor: color,
          onMouseDown: () => this.showEventDetails(event),
        })
        const eventTitle = new TextRenderable(this.renderer, {
          id: `allday-title-${index}`,
          content: this.truncate(event.title, 28),
          fg: COLORS.fg,
        })
        eventBox.add(eventTitle)
        this.eventsBox?.add(eventBox)
      })
    }

    const timedHeader = new TextRenderable(this.renderer, {
      id: "timed-events-header",
      content: "Events",
      fg: COLORS.otherMonthFg,
      marginTop: 1,
    })
    this.eventsBox.add(timedHeader)

    this.eventsScrollBox = new ScrollBoxRenderable(this.renderer, {
      id: "events-scroll",
      flexGrow: 1,
      backgroundColor: "transparent",
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: COLORS.scrollThumb,
          backgroundColor: COLORS.scrollBg,
        },
      },
    })
    this.eventsBox.add(this.eventsScrollBox)
    this.updateEventsList()
  }

  private updateEventsList() {
    if (!this.eventsScrollBox || !this.eventsBox) return

    this.eventsScrollBox.getChildren().forEach(child => this.eventsScrollBox?.remove(child.id))

    const dayEvents = this.getEventsForDate(this.selectedDate)
      .filter(event => Boolean(event.time))
      .sort((a, b) => (a.time || "").localeCompare(b.time || ""))

    if (dayEvents.length === 0) {
      const emptyText = new TextRenderable(this.renderer, {
        id: "no-events-text",
        content: "No timed events",
        fg: COLORS.otherMonthFg,
        marginTop: 1,
      })
      this.eventsScrollBox.add(emptyText)
    } else {
      dayEvents.forEach((event, index) => {
        const color = this.calendars.find(calendar => calendar.id === event.calendarId)?.color || COLORS.eventDot
        const eventBox = new BoxRenderable(this.renderer, {
          id: `timed-event-${index}`,
          width: "100%",
          flexShrink: 0,
          backgroundColor: index % 2 === 0 ? COLORS.bg : "transparent",
          padding: 1,
          marginBottom: 1,
          border: true,
          borderStyle: "single",
          borderColor: color,
          onMouseDown: () => this.showEventDetails(event),
        })

        const timeText = new TextRenderable(this.renderer, {
          id: `timed-event-time-${index}`,
          content: event.time || "",
          fg: color,
        })
        eventBox.add(timeText)

        const titleText = new TextRenderable(this.renderer, {
          id: `timed-event-title-${index}`,
          content: this.truncate(event.title, 30),
          fg: COLORS.fg,
          marginTop: 0,
        })
        eventBox.add(titleText)

        if (event.location) {
          const locationText = new TextRenderable(this.renderer, {
            id: `timed-event-location-${index}`,
            content: this.truncate(`@ ${event.location}`, 30),
            fg: COLORS.otherMonthFg,
            marginTop: 0,
          })
          eventBox.add(locationText)
        }

        this.eventsScrollBox?.add(eventBox)
      })
    }

    const selectedDateHeader = this.eventsBox.getRenderable("selected-date-header") as TextRenderable | undefined
    if (selectedDateHeader) {
      selectedDateHeader.content = format(this.selectedDate, "EEEE, MMM d")
    }
  }

  private truncate(text: string, maxLength: number): string {
    if (maxLength <= 0) return ""
    if (text.length <= maxLength) return text
    if (maxLength <= 1) return text.slice(0, maxLength)
    return `${text.slice(0, maxLength - 1)}~`
  }

  private async refreshCalendar(forceFetch = false) {
    await this.loadEventsIfNeeded(forceFetch)

    if (this.rootBox) {
      this.rootBox.destroyRecursively()
      this.rootBox = null
    }
    this.createLayout()
    this.renderer.requestRender()
  }

  private async setViewMode(mode: ViewMode) {
    if (this.viewMode === mode) return
    this.viewMode = mode
    this.currentDate = this.selectedDate
    this.weekStart = startOfWeek(this.selectedDate, { weekStartsOn: 0 })
    await this.refreshCalendar()
  }

  private isModalOpen(): boolean {
    return Boolean(
      this.renderer.root.getRenderable("calendar-overlay") ||
      this.renderer.root.getRenderable("help-overlay") ||
      this.renderer.root.getRenderable("event-overlay")
    )
  }

  private setupKeyboardHandling() {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      void this.handleKeypress(key)
    })
  }

  private async handleKeypress(key: KeyEvent) {
    if (this.isModalOpen()) return

    if (key.sequence === "?") {
      this.showHelpOverlay()
      return
    }

    switch (key.name) {
      case "q":
        if (!key.ctrl) this.cleanup()
        return
      case "left":
        await this.navigateDay(-1)
        return
      case "right":
        await this.navigateDay(1)
        return
      case "up":
      case "k":
        await this.navigateWeek(-1)
        return
      case "down":
      case "j":
        await this.navigateWeek(1)
        return
      case "h":
        await this.navigateMonth(-1)
        return
      case "l":
        await this.navigateMonth(1)
        return
      case "d":
      case "1":
        await this.setViewMode("day")
        return
      case "w":
      case "2":
        await this.setViewMode("week")
        return
      case "m":
      case "3":
        await this.setViewMode("month")
        return
      case "t":
        await this.goToToday()
        return
      case "r":
        await this.refreshEvents()
        return
      case "c":
        this.showCalendarSelector()
        return
      case "s":
        await this.toggleSidebar()
        return
      case "slash":
        if (key.shift) this.showHelpOverlay()
        return
      default:
        return
    }
  }

  private async navigateDay(days: number) {
    this.selectedDate = addDays(this.selectedDate, days)
    this.currentDate = this.selectedDate
    this.weekStart = startOfWeek(this.selectedDate, { weekStartsOn: 0 })
    await this.refreshCalendar()
  }

  private async navigateWeek(weeks: number) {
    this.selectedDate = addWeeks(this.selectedDate, weeks)
    this.currentDate = this.selectedDate
    this.weekStart = startOfWeek(this.selectedDate, { weekStartsOn: 0 })
    await this.refreshCalendar()
  }

  private async navigateMonth(direction: number) {
    this.selectedDate = direction > 0 ? addMonths(this.selectedDate, 1) : subMonths(this.selectedDate, 1)
    this.currentDate = this.selectedDate
    this.weekStart = startOfWeek(this.selectedDate, { weekStartsOn: 0 })
    await this.refreshCalendar()
  }

  private async goToToday() {
    const today = new Date()
    this.currentDate = today
    this.selectedDate = today
    this.weekStart = startOfWeek(today, { weekStartsOn: 0 })
    await this.refreshCalendar()
  }

  private async refreshEvents() {
    if (!this.isGoogleConnected) {
      await this.refreshCalendar()
      return
    }
    await this.refreshCalendar(true)
  }

  private async toggleSidebar() {
    this.sidebarEnabled = !this.sidebarEnabled
    await this.refreshCalendar()
  }

  private showHelpOverlay() {
    if (this.isModalOpen()) return

    const overlay = new BoxRenderable(this.renderer, {
      id: "help-overlay",
      width: "100%",
      height: "100%",
      backgroundColor: COLORS.overlayBg,
      position: "absolute",
      top: 0,
      left: 0,
      zIndex: 100,
      justifyContent: "center",
      alignItems: "center",
    })
    this.renderer.root.add(overlay)

    const dialog = new BoxRenderable(this.renderer, {
      id: "help-dialog",
      width: 70,
      height: "auto",
      flexDirection: "column",
      backgroundColor: COLORS.headerBg,
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.border,
      padding: 2,
    })
    overlay.add(dialog)

    const title = new TextRenderable(this.renderer, {
      id: "help-title",
      content: "Keyboard Commands",
      fg: COLORS.headerFg,
      alignSelf: "center",
      marginBottom: 1,
    })
    dialog.add(title)

    const lines = [
      "Views: d day, w week, m month (also 1/2/3)",
      "Navigate day: left / right",
      "Navigate week: up / down (or k / j)",
      "Navigate month: h / l",
      "Today: t",
      "Refresh events: r",
      "Toggle calendars: c",
      "Toggle sidebar: s",
      "Event details: click event card in sidebar",
      "Quit: q",
      "Close this help: ?, esc, or enter",
    ]

    lines.forEach((line, index) => {
      const text = new TextRenderable(this.renderer, {
        id: `help-line-${index}`,
        content: line,
        fg: COLORS.fg,
      })
      dialog.add(text)
    })

    const close = () => {
      this.renderer.keyInput.off("keypress", closeHandler)
      overlay.destroyRecursively()
      this.renderer.requestRender()
    }

    const closeHandler = (key: KeyEvent) => {
      if (
        key.name === "escape" ||
        key.name === "return" ||
        key.name === "linefeed" ||
        key.name === "q" ||
        key.sequence === "?"
      ) {
        close()
      }
    }

    this.renderer.keyInput.on("keypress", closeHandler)
    this.renderer.requestRender()
  }

  private showEventDetails(event: CalendarEvent) {
    if (this.isModalOpen()) return

    const overlay = new BoxRenderable(this.renderer, {
      id: "event-overlay",
      width: "100%",
      height: "100%",
      backgroundColor: COLORS.overlayBg,
      position: "absolute",
      top: 0,
      left: 0,
      zIndex: 100,
      justifyContent: "center",
      alignItems: "center",
    })
    this.renderer.root.add(overlay)

    const dialog = new BoxRenderable(this.renderer, {
      id: "event-dialog",
      width: 72,
      height: "auto",
      flexDirection: "column",
      backgroundColor: COLORS.headerBg,
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.border,
      padding: 2,
    })
    overlay.add(dialog)

    const calendarName = this.calendars.find(calendar => calendar.id === event.calendarId)?.name

    const title = new TextRenderable(this.renderer, {
      id: "event-title",
      content: this.truncate(event.title, 64),
      fg: COLORS.headerFg,
      marginBottom: 1,
    })
    dialog.add(title)

    const details: string[] = []
    details.push(event.time ? `Time: ${event.time}` : "Time: All day")
    details.push(`Date: ${format(event.date, "EEEE, MMM d, yyyy")}`)
    if (calendarName) details.push(`Calendar: ${this.truncate(calendarName, 56)}`)
    if (event.location) details.push(`Location: ${this.truncate(event.location, 56)}`)
    if (event.description) details.push(`Notes: ${this.truncate(event.description, 58)}`)

    details.forEach((line, index) => {
      const detail = new TextRenderable(this.renderer, {
        id: `event-detail-line-${index}`,
        content: line,
        fg: COLORS.fg,
      })
      dialog.add(detail)
    })

    const hint = new TextRenderable(this.renderer, {
      id: "event-detail-hint",
      content: "Press esc, enter, or q to close",
      fg: COLORS.otherMonthFg,
      marginTop: 1,
      alignSelf: "center",
    })
    dialog.add(hint)

    const close = () => {
      this.renderer.keyInput.off("keypress", closeHandler)
      overlay.destroyRecursively()
      this.renderer.requestRender()
    }

    const closeHandler = (key: KeyEvent) => {
      if (
        key.name === "escape" ||
        key.name === "return" ||
        key.name === "linefeed" ||
        key.name === "q"
      ) {
        close()
      }
    }

    this.renderer.keyInput.on("keypress", closeHandler)
    this.renderer.requestRender()
  }

  private showCalendarSelector() {
    if (!this.isGoogleConnected || this.calendars.length === 0 || this.isModalOpen()) return

    const overlay = new BoxRenderable(this.renderer, {
      id: "calendar-overlay",
      width: "100%",
      height: "100%",
      backgroundColor: COLORS.overlayBg,
      position: "absolute",
      top: 0,
      left: 0,
      zIndex: 100,
      justifyContent: "center",
      alignItems: "center",
    })
    this.renderer.root.add(overlay)

    const dialogBox = new BoxRenderable(this.renderer, {
      id: "calendar-dialog",
      width: 54,
      height: "auto",
      flexDirection: "column",
      backgroundColor: COLORS.headerBg,
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.border,
      padding: 2,
    })
    overlay.add(dialogBox)

    const titleText = new TextRenderable(this.renderer, {
      id: "calendar-dialog-title",
      content: "Select Calendars",
      fg: COLORS.headerFg,
      alignSelf: "center",
      marginBottom: 1,
    })
    dialogBox.add(titleText)

    const calendarListBox = new BoxRenderable(this.renderer, {
      id: "calendar-list",
      flexDirection: "column",
      gap: 0,
    })
    dialogBox.add(calendarListBox)

    let selectedIndex = 0
    const originalEnabledState = this.calendars.map(calendar => calendar.enabled)

    const renderCalendarItems = () => {
      calendarListBox.getChildren().forEach(child => calendarListBox.remove(child.id))

      this.calendars.forEach((calendar, index) => {
        const selected = index === selectedIndex
        const item = new BoxRenderable(this.renderer, {
          id: `calendar-item-${index}`,
          width: "100%",
          backgroundColor: selected ? COLORS.selectedBg : "transparent",
          height: 1,
        })

        const check = calendar.enabled ? "[x]" : "[ ]"
        const line = new TextRenderable(this.renderer, {
          id: `calendar-item-text-${index}`,
          content: `${check} ${this.truncate(calendar.name, 46)}`,
          fg: selected ? COLORS.selectedFg : COLORS.fg,
        })
        item.add(line)
        calendarListBox.add(item)
      })
    }

    renderCalendarItems()

    const hintText = new TextRenderable(this.renderer, {
      id: "calendar-hint",
      content: "up/down move, space toggle, enter save, esc cancel",
      fg: COLORS.dayHeaderFg,
      alignSelf: "center",
      marginTop: 1,
    })
    dialogBox.add(hintText)

    const close = async (applyChanges: boolean) => {
      this.renderer.keyInput.off("keypress", handleKey)
      overlay.destroyRecursively()

      if (applyChanges) {
        this.selectedCalendarIds = this.calendars.filter(calendar => calendar.enabled).map(calendar => calendar.id)
        await this.persistUiState()
        this.loadedRange = null
        await this.refreshCalendar(true)
      } else {
        this.calendars.forEach((calendar, index) => {
          calendar.enabled = originalEnabledState[index] ?? calendar.enabled
        })
        this.renderer.requestRender()
      }
    }

    const handleKey = (key: KeyEvent) => {
      void (async () => {
        if (key.name === "up" || key.name === "k") {
          selectedIndex = Math.max(0, selectedIndex - 1)
          renderCalendarItems()
          this.renderer.requestRender()
          return
        }

        if (key.name === "down" || key.name === "j") {
          selectedIndex = Math.min(this.calendars.length - 1, selectedIndex + 1)
          renderCalendarItems()
          this.renderer.requestRender()
          return
        }

        if (key.name === "space") {
          const target = this.calendars[selectedIndex]
          if (target) {
            target.enabled = !target.enabled
            renderCalendarItems()
            this.renderer.requestRender()
          }
          return
        }

        if (key.name === "return" || key.name === "linefeed") {
          await close(true)
          return
        }

        if (key.name === "escape" || key.name === "q") {
          await close(false)
        }
      })()
    }

    this.renderer.keyInput.on("keypress", handleKey)
    this.renderer.requestRender()
  }

  private cleanup() {
    if (this.resizeHandler) {
      process.stdout.off("resize", this.resizeHandler)
      this.resizeHandler = null
    }
    this.renderer.destroy()
    process.exit(0)
  }
}

const app = new GoogleCalendarTUI()
app.init().catch(console.error)
