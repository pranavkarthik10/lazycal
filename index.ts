import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  type KeyEvent,
} from "@opentui/core"
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays, isSameMonth, isSameDay, addMonths, subMonths, addWeeks, subWeeks, getDay, getDate, isToday } from "date-fns"
import { GoogleCalendarClient, generateSampleEvents, type CalendarEvent } from "./google-calendar"

// Color themes
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
  synced: "#48BB78",
  offline: "#F6AD55",
  timeColumn: "#1A202C",
}

interface CalendarConfig {
  id: string
  name: string
  color: string
  enabled: boolean
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)

class GoogleCalendarTUI {
  private renderer: Awaited<ReturnType<typeof createCliRenderer>>
  private currentDate: Date
  private selectedDate: Date
  private events: CalendarEvent[]
  private googleClient: GoogleCalendarClient
  private isGoogleConnected = false
  private calendars: CalendarConfig[] = []
  private selectedCalendarIds: string[] = []
  private weekStart: Date

  // UI Components
  private rootBox: BoxRenderable | null = null
  private eventsScrollBox: ScrollBoxRenderable | null = null
  private eventsBox: BoxRenderable | null = null
  private weekViewScrollBox: ScrollBoxRenderable | null = null

  constructor() {
    this.currentDate = new Date()
    this.selectedDate = new Date()
    this.weekStart = startOfWeek(new Date(), { weekStartsOn: 0 })
    this.events = generateSampleEvents()
    this.googleClient = new GoogleCalendarClient()
  }

  async init() {
    console.log("Checking for Google Calendar credentials...")
    this.isGoogleConnected = await this.googleClient.initialize()
    
    if (this.isGoogleConnected) {
      console.log("Connected to Google Calendar!")
      
      const availableCalendars = await this.googleClient.listCalendars()
      this.calendars = availableCalendars.map((cal, index) => ({
        id: cal.id,
        name: cal.name,
        color: ["#4285F4", "#EA4335", "#FBBC04", "#34A853", "#9AA0A6", "#673AB7"][index % 6],
        enabled: true,
      }))
      
      this.selectedCalendarIds = this.calendars.map(c => c.id)
      console.log(`Found ${this.calendars.length} calendars`)
      this.events = await this.googleClient.fetchEventsFromCalendars(this.selectedDate, this.selectedCalendarIds)
    } else {
      console.log("Using sample data. Add credentials to use real Google Calendar.")
    }

    this.renderer = await createCliRenderer({
      exitOnCtrlC: true,
      targetFps: 30,
    })

    this.renderer.setBackgroundColor(COLORS.bg)
    this.createLayout()
    this.setupKeyboardHandling()
    this.renderer.requestRender()
  }

  private getWeekDays(): Date[] {
    const days: Date[] = []
    for (let i = 0; i < 7; i++) {
      days.push(addDays(this.weekStart, i))
    }
    return days
  }

  private getEventsForDate(date: Date): CalendarEvent[] {
    return this.events.filter(event => isSameDay(event.date, date))
  }

  private getEventsForHour(date: Date, hour: number): CalendarEvent[] {
    return this.events.filter(event => {
      if (!isSameDay(event.date, date)) return false
      if (!event.time) return false // All-day events handled separately
      const eventHour = parseInt(event.time.split(":")[0])
      return eventHour === hour
    })
  }

  private createLayout() {
    // Main container
    this.rootBox = new BoxRenderable(this.renderer, {
      id: "root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: COLORS.bg,
    })
    this.renderer.root.add(this.rootBox)

    // Header
    const headerBox = new BoxRenderable(this.renderer, {
      id: "header",
      height: 3,
      flexShrink: 0,
      flexDirection: "column",
      backgroundColor: COLORS.headerBg,
      padding: 1,
    })
    this.rootBox.add(headerBox)

    // Week range display
    const weekDays = this.getWeekDays()
    const weekRangeText = `${format(weekDays[0], "MMM d")} - ${format(weekDays[6], "MMM d, yyyy")}`
    const statusIcon = this.isGoogleConnected ? "●" : "○"
    const statusText = this.isGoogleConnected 
      ? `(${this.calendars.filter(c => c.enabled).length} calendars)` 
      : "Sample Data"
    
    const titleText = new TextRenderable(this.renderer, {
      id: "week-title",
      content: `${weekRangeText}  ${statusIcon} ${statusText}`,
      fg: COLORS.headerFg,
      alignSelf: "center",
    })
    headerBox.add(titleText)

    // Navigation hints
    const hintsText = new TextRenderable(this.renderer, {
      id: "hints",
      content: "←→: Day  |  ↑↓: Week  |  h/l: Month  |  Enter: Details  |  c: Calendars  |  t: Today  |  q: Quit",
      fg: COLORS.dayHeaderFg,
      alignSelf: "center",
    })
    headerBox.add(hintsText)

    // Main content
    const contentBox = new BoxRenderable(this.renderer, {
      id: "content",
      flexGrow: 1,
      flexDirection: "row",
    })
    this.rootBox.add(contentBox)

    // Week view container
    const weekContainer = new BoxRenderable(this.renderer, {
      id: "week-container",
      flexGrow: 1,
      flexDirection: "column",
      padding: 1,
    })
    contentBox.add(weekContainer)

    // Day headers
    const dayHeadersBox = new BoxRenderable(this.renderer, {
      id: "day-headers",
      height: 2,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
    })
    weekContainer.add(dayHeadersBox)

    // Time column header (empty)
    const timeHeaderBox = new BoxRenderable(this.renderer, {
      id: "time-header",
      width: 6,
      height: 2,
      flexShrink: 0,
      backgroundColor: COLORS.timeColumn,
      border: true,
      borderStyle: "single",
      borderColor: COLORS.border,
    })
    dayHeadersBox.add(timeHeaderBox)

    // Day headers
    const weekDays_list = this.getWeekDays()
    weekDays_list.forEach((day, index) => {
      const isSelected = isSameDay(day, this.selectedDate)
      const isTodayDate = isToday(day)
      const isWeekend = index === 0 || index === 6
      
      const dayHeader = new BoxRenderable(this.renderer, {
        id: `day-header-${index}`,
        flexGrow: 1,
        height: 2,
        backgroundColor: isSelected ? COLORS.selectedBg : isTodayDate ? COLORS.todayBg : isWeekend ? COLORS.weekendBg : COLORS.dayHeaderBg,
        border: true,
        borderStyle: isSelected || isTodayDate ? "double" : "single",
        borderColor: isSelected ? COLORS.selectedFg : isTodayDate ? COLORS.todayFg : COLORS.border,
        flexDirection: "column",
      })

      const dayNameText = new TextRenderable(this.renderer, {
        id: `day-name-${index}`,
        content: format(day, "EEE"),
        fg: isSelected || isTodayDate ? COLORS.selectedFg : COLORS.dayHeaderFg,
        alignSelf: "center",
      })
      dayHeader.add(dayNameText)

      const dayNumText = new TextRenderable(this.renderer, {
        id: `day-num-${index}`,
        content: String(getDate(day)),
        fg: isSelected || isTodayDate ? COLORS.selectedFg : COLORS.dayHeaderFg,
        alignSelf: "center",
        marginTop: 0,
      })
      dayHeader.add(dayNumText)

      dayHeadersBox.add(dayHeader)
    })

    // Week view scrollable area
    this.weekViewScrollBox = new ScrollBoxRenderable(this.renderer, {
      id: "week-scroll",
      flexGrow: 1,
      backgroundColor: "transparent",
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: COLORS.scrollThumb,
          backgroundColor: COLORS.scrollBg,
        },
      },
    })
    weekContainer.add(this.weekViewScrollBox)

    // Time slots
    HOURS.forEach(hour => {
      const hourRow = new BoxRenderable(this.renderer, {
        id: `hour-row-${hour}`,
        width: "100%",
        height: 3,
        flexShrink: 0,
        flexDirection: "row",
        gap: 1,
      })

      // Time label
      const timeLabel = new BoxRenderable(this.renderer, {
        id: `time-label-${hour}`,
        width: 6,
        height: 3,
        flexShrink: 0,
        backgroundColor: COLORS.timeColumn,
        border: true,
        borderStyle: "single",
        borderColor: COLORS.border,
      })
      const timeText = new TextRenderable(this.renderer, {
        id: `time-text-${hour}`,
        content: `${hour.toString().padStart(2, "0")}:00`,
        fg: COLORS.otherMonthFg,
        alignSelf: "center",
      })
      timeLabel.add(timeText)
      hourRow.add(timeLabel)

      // Day columns for this hour
      weekDays_list.forEach((day, dayIndex) => {
        const isSelected = isSameDay(day, this.selectedDate)
        const isTodayDate = isToday(day)
        const isWeekend = dayIndex === 0 || dayIndex === 6
        const hourEvents = this.getEventsForHour(day, hour)
        const hasEvents = hourEvents.length > 0

        const dayCell = new BoxRenderable(this.renderer, {
          id: `day-cell-${hour}-${dayIndex}`,
          flexGrow: 1,
          height: 3,
          backgroundColor: isSelected ? COLORS.selectedBg : isWeekend ? COLORS.weekendBg : COLORS.bg,
          border: true,
          borderStyle: "single",
          borderColor: isSelected ? COLORS.selectedFg : COLORS.border,
          padding: 0,
        })

        // Show events in this cell
        if (hasEvents) {
          hourEvents.slice(0, 1).forEach((event, i) => {
            const calendar = this.calendars.find(c => c.id === event.calendarId)
            const eventColor = calendar?.color || COLORS.eventDot

            const eventText = new TextRenderable(this.renderer, {
              id: `event-${hour}-${dayIndex}-${i}`,
              content: event.title.length > 8 ? event.title.slice(0, 7) + "…" : event.title,
              fg: eventColor,
              marginTop: 0,
              marginLeft: 0,
            })
            dayCell.add(eventText)
          })
        }

        hourRow.add(dayCell)
      })

      this.weekViewScrollBox.add(hourRow)
    })

    // Scroll to current hour on init
    const currentHour = new Date().getHours()
    const scrollPos = Math.max(0, (currentHour - 2) * 3)
    setTimeout(() => {
      this.weekViewScrollBox?.scrollTo({ x: 0, y: scrollPos })
    }, 100)

    // Events sidebar
    this.eventsBox = new BoxRenderable(this.renderer, {
      id: "events-box",
      width: 35,
      flexShrink: 0,
      flexDirection: "column",
      border: true,
      borderStyle: "single",
      borderColor: COLORS.border,
      backgroundColor: COLORS.headerBg,
      padding: 1,
    })
    contentBox.add(this.eventsBox)

    // Selected date header
    const selectedDateHeader = new TextRenderable(this.renderer, {
      id: "selected-date-header",
      content: format(this.selectedDate, "EEEE, MMM d"),
      fg: COLORS.headerFg,
      marginBottom: 1,
    })
    this.eventsBox.add(selectedDateHeader)

    // All-day events section
    const allDayEvents = this.getEventsForDate(this.selectedDate).filter(e => !e.time)
    if (allDayEvents.length > 0) {
      const allDayHeader = new TextRenderable(this.renderer, {
        id: "allday-header",
        content: "All Day",
        fg: COLORS.otherMonthFg,
        marginBottom: 0,
      })
      this.eventsBox.add(allDayHeader)

      allDayEvents.forEach((event, index) => {
        const calendar = this.calendars.find(c => c.id === event.calendarId)
        const eventBox = new BoxRenderable(this.renderer, {
          id: `allday-event-${index}`,
          width: "100%",
          flexShrink: 0,
          backgroundColor: COLORS.bg,
          padding: 1,
          marginBottom: 1,
          border: true,
          borderStyle: "single",
          borderColor: calendar?.color || COLORS.eventDot,
        })

        const eventTitle = new TextRenderable(this.renderer, {
          id: `allday-title-${index}`,
          content: event.title,
          fg: COLORS.fg,
        })
        eventBox.add(eventTitle)
        this.eventsBox.add(eventBox)
      })
    }

    // Timed events list
    const timedEventsHeader = new TextRenderable(this.renderer, {
      id: "timed-header",
      content: "Events",
      fg: COLORS.otherMonthFg,
      marginTop: allDayEvents.length > 0 ? 1 : 0,
      marginBottom: 0,
    })
    this.eventsBox.add(timedEventsHeader)

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
    if (!this.eventsScrollBox) return

    const children = this.eventsScrollBox.getChildren()
    const childIds = children.map(child => child.id)
    childIds.forEach(id => {
      this.eventsScrollBox?.remove(id)
    })

    const dayEvents = this.getEventsForDate(this.selectedDate).filter(e => e.time)
    dayEvents.sort((a, b) => (a.time || "").localeCompare(b.time || ""))

    if (dayEvents.length === 0) {
      const noEventsText = new TextRenderable(this.renderer, {
        id: "no-events",
        content: "No timed events",
        fg: COLORS.otherMonthFg,
        alignSelf: "center",
        marginTop: 2,
      })
      this.eventsScrollBox.add(noEventsText)
    } else {
      dayEvents.forEach((event, index) => {
        const calendar = this.calendars.find(c => c.id === event.calendarId)
        const eventColor = calendar?.color || COLORS.eventDot

        const eventBox = new BoxRenderable(this.renderer, {
          id: `event-${index}`,
          width: "100%",
          flexShrink: 0,
          backgroundColor: index % 2 === 0 ? COLORS.bg : "transparent",
          padding: 1,
          marginBottom: 1,
          border: true,
          borderStyle: "single",
          borderColor: eventColor,
        })

        const eventTime = new TextRenderable(this.renderer, {
          id: `event-time-${index}`,
          content: event.time || "",
          fg: eventColor,
        })
        eventBox.add(eventTime)

        const eventTitle = new TextRenderable(this.renderer, {
          id: `event-title-${index}`,
          content: event.title,
          fg: COLORS.fg,
          marginTop: 0,
        })
        eventBox.add(eventTitle)

        if (event.location) {
          const eventLocation = new TextRenderable(this.renderer, {
            id: `event-location-${index}`,
            content: `📍 ${event.location}`,
            fg: COLORS.otherMonthFg,
            marginTop: 0,
          })
          eventBox.add(eventLocation)
        }

        this.eventsScrollBox.add(eventBox)
      })
    }

    // Update selected date header
    const selectedDateHeader = this.eventsBox?.getRenderable("selected-date-header") as TextRenderable
    if (selectedDateHeader) {
      selectedDateHeader.content = format(this.selectedDate, "EEEE, MMM d")
    }

    this.renderer.requestRender()
  }

  private showCalendarSelector() {
    if (!this.isGoogleConnected || this.calendars.length === 0) return

    const overlay = new BoxRenderable(this.renderer, {
      id: "calendar-overlay",
      width: "100%",
      height: "100%",
      backgroundColor: "rgba(0,0,0,0.7)",
      position: "absolute",
      top: 0,
      left: 0,
      zIndex: 100,
    })
    this.renderer.root.add(overlay)

    const dialogBox = new BoxRenderable(this.renderer, {
      id: "calendar-dialog",
      width: 50,
      height: "auto",
      flexDirection: "column",
      backgroundColor: COLORS.headerBg,
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.border,
      padding: 2,
      alignSelf: "center",
      marginTop: 5,
    })
    overlay.add(dialogBox)

    const titleText = new TextRenderable(this.renderer, {
      id: "calendar-dialog-title",
      content: "Select Calendars (Space to toggle)",
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
    const calendarItems: { box: BoxRenderable; text: TextRenderable; cal: CalendarConfig }[] = []

    // Render calendar items
    const renderCalendarItems = () => {
      calendarListBox.clear?.() || calendarListBox.getChildren().forEach(c => calendarListBox.remove(c.id))
      calendarItems.length = 0

      this.calendars.forEach((cal, index) => {
        const isSelected = index === selectedIndex
        const itemBox = new BoxRenderable(this.renderer, {
          id: `cal-item-${index}`,
          width: "100%",
          height: 1,
          backgroundColor: isSelected ? COLORS.selectedBg : "transparent",
          padding: 0,
          marginBottom: 0,
        })

        const checkmark = cal.enabled ? "☑" : "☐"
        const itemText = new TextRenderable(this.renderer, {
          id: `cal-text-${index}`,
          content: `${checkmark} ${cal.name}`,
          fg: isSelected ? COLORS.selectedFg : COLORS.fg,
        })
        itemBox.add(itemText)
        calendarListBox.add(itemBox)
        calendarItems.push({ box: itemBox, text: itemText, cal })
      })
    }

    renderCalendarItems()

    const hintText = new TextRenderable(this.renderer, {
      id: "calendar-hint",
      content: "↑↓: Navigate  |  Space: Toggle  |  Enter: Done",
      fg: COLORS.dayHeaderFg,
      alignSelf: "center",
      marginTop: 1,
    })
    dialogBox.add(hintText)

    // Handle keyboard
    const handleKey = (key: KeyEvent) => {
      if (key.name === "space") {
        const cal = this.calendars[selectedIndex]
        if (cal) {
          cal.enabled = !cal.enabled
          renderCalendarItems()
          this.renderer.requestRender()
        }
      } else if (key.name === "up" || key.name === "k") {
        selectedIndex = Math.max(0, selectedIndex - 1)
        renderCalendarItems()
        this.renderer.requestRender()
      } else if (key.name === "down" || key.name === "j") {
        selectedIndex = Math.min(this.calendars.length - 1, selectedIndex + 1)
        renderCalendarItems()
        this.renderer.requestRender()
      } else if (key.name === "return" || key.name === "linefeed" || key.name === "escape") {
        overlay.destroy()
        this.renderer.keyInput.off("keypress", handleKey)
        
        this.selectedCalendarIds = this.calendars.filter(c => c.enabled).map(c => c.id)
        
        if (this.isGoogleConnected) {
          this.googleClient.fetchEventsFromCalendars(this.selectedDate, this.selectedCalendarIds)
            .then(events => {
              this.events = events
              this.refreshCalendar()
            })
        }
      }
    }

    this.renderer.keyInput.on("keypress", handleKey)
    this.renderer.requestRender()
  }

  private async refreshCalendar() {
    if (this.rootBox) {
      this.rootBox.destroyRecursively()
    }
    this.createLayout()
    this.renderer.requestRender()
  }

  private setupKeyboardHandling() {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      // Don't process if we're in a modal
      if (this.renderer.root.getRenderable("calendar-overlay")) return

      switch (key.name) {
        case "q":
          if (!key.ctrl) {
            this.cleanup()
          }
          break
        case "left":
          this.navigateDay(-1)
          break
        case "right":
          this.navigateDay(1)
          break
        case "up":
          this.navigateWeek(-1)
          break
        case "down":
          this.navigateWeek(1)
          break
        case "h":
          this.navigateMonth(-1)
          break
        case "l":
          this.navigateMonth(1)
          break
        case "return":
        case "linefeed":
          this.viewDayDetails()
          break
        case "t":
          this.goToToday()
          break
        case "r":
          this.refreshEvents()
          break
        case "c":
          this.showCalendarSelector()
          break
      }
    })
  }

  private navigateDay(days: number) {
    this.selectedDate = addDays(this.selectedDate, days)
    
    // Update week if needed
    const newWeekStart = startOfWeek(this.selectedDate, { weekStartsOn: 0 })
    if (!isSameDay(newWeekStart, this.weekStart)) {
      this.weekStart = newWeekStart
      this.currentDate = this.selectedDate
      if (this.isGoogleConnected) {
        this.googleClient.fetchEventsFromCalendars(this.selectedDate, this.selectedCalendarIds)
          .then(events => {
            this.events = events
            this.refreshCalendar()
          })
      } else {
        this.refreshCalendar()
      }
    } else {
      this.refreshCalendar()
    }
  }

  private navigateWeek(weeks: number) {
    this.weekStart = addWeeks(this.weekStart, weeks)
    this.selectedDate = addWeeks(this.selectedDate, weeks)
    this.currentDate = this.selectedDate
    
    if (this.isGoogleConnected) {
      this.googleClient.fetchEventsFromCalendars(this.selectedDate, this.selectedCalendarIds)
        .then(events => {
          this.events = events
          this.refreshCalendar()
        })
    } else {
      this.refreshCalendar()
    }
  }

  private async navigateMonth(direction: number) {
    if (direction > 0) {
      this.currentDate = addMonths(this.currentDate, 1)
    } else {
      this.currentDate = subMonths(this.currentDate, 1)
    }
    this.selectedDate = this.currentDate
    this.weekStart = startOfWeek(this.selectedDate, { weekStartsOn: 0 })
    
    if (this.isGoogleConnected) {
      this.events = await this.googleClient.fetchEventsFromCalendars(this.selectedDate, this.selectedCalendarIds)
    }
    
    await this.refreshCalendar()
  }

  private goToToday() {
    const today = new Date()
    this.currentDate = today
    this.selectedDate = today
    this.weekStart = startOfWeek(today, { weekStartsOn: 0 })
    
    if (this.isGoogleConnected) {
      this.googleClient.fetchEventsFromCalendars(today, this.selectedCalendarIds)
        .then(events => {
          this.events = events
          this.refreshCalendar()
        })
    } else {
      this.refreshCalendar()
    }
  }

  private async refreshEvents() {
    if (this.isGoogleConnected) {
      console.log("\nRefreshing events...")
      this.events = await this.googleClient.fetchEventsFromCalendars(this.selectedDate, this.selectedCalendarIds)
      this.updateEventsList()
      this.refreshCalendar()
      console.log("Events refreshed!\n")
    }
  }

  private viewDayDetails() {
    const events = this.getEventsForDate(this.selectedDate)
    console.log(`\nEvents for ${format(this.selectedDate, "MMMM d, yyyy")}:`)
    if (events.length === 0) {
      console.log("  No events")
    } else {
      events.forEach(event => {
        const calendar = this.calendars.find(c => c.id === event.calendarId)
        console.log(`  ${event.time || "All day"}: ${event.title}`)
        if (calendar) {
          console.log(`    📅 ${calendar.name}`)
        }
        if (event.description) {
          console.log(`    ${event.description}`)
        }
        if (event.location) {
          console.log(`    📍 ${event.location}`)
        }
      })
    }
    console.log("")
  }

  private cleanup() {
    this.renderer.destroy()
    process.exit(0)
  }
}

// Run the application
const app = new GoogleCalendarTUI()
app.init().catch(console.error)
