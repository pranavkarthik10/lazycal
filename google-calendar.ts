/**
 * Google Calendar API Integration Module
 * 
 * This module handles authentication and API calls to Google Calendar.
 * To use real Google Calendar data, you'll need to:
 * 
 * 1. Create a project in Google Cloud Console
 * 2. Enable the Google Calendar API
 * 3. Create OAuth 2.0 credentials (Desktop application type)
 * 4. Download the credentials JSON file
 * 5. Place it at ~/.config/lazycal/credentials.json
 * 
 * On first run, the app will open a browser for OAuth authentication
 * and save the token to ~/.config/lazycal/token.json
 */

import { google, calendar_v3 } from "googleapis"
import { OAuth2Client } from "google-auth-library"
import * as fs from "fs/promises"
import * as path from "path"
import { homedir } from "os"
import { startOfWeek, endOfWeek } from "date-fns"
import * as http from "http"
import * as url from "url"

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]
const CONFIG_DIR = path.join(homedir(), ".config", "lazycal")
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json")
const TOKEN_PATH = path.join(CONFIG_DIR, "token.json")
const REDIRECT_PORT = 8080

export interface CalendarEvent {
  id: string
  title: string
  date: Date
  time?: string
  description?: string
  location?: string
  calendarId?: string
  calendarName?: string
}

export class GoogleCalendarClient {
  private auth: OAuth2Client | null = null
  private calendar: calendar_v3.Calendar | null = null

  async initialize(): Promise<boolean> {
    try {
      await fs.access(CREDENTIALS_PATH)
    } catch {
      console.log("Google Calendar credentials not found.")
      console.log(`Please place your credentials.json at: ${CREDENTIALS_PATH}`)
      return false
    }

    try {
      const credentials = JSON.parse(await fs.readFile(CREDENTIALS_PATH, "utf-8"))
      const { client_secret, client_id } = credentials.installed
      
      // Use localhost redirect for automatic callback
      const redirectUri = `http://localhost:${REDIRECT_PORT}/oauth2callback`
      this.auth = new OAuth2Client(client_id, client_secret, redirectUri)
      
      try {
        const token = JSON.parse(await fs.readFile(TOKEN_PATH, "utf-8"))
        this.auth.setCredentials(token)
      } catch {
        await this.getNewTokenAutomatic()
      }

      this.calendar = google.calendar({ version: "v3", auth: this.auth })
      return true
    } catch (error) {
      console.error("Error initializing Google Calendar:", error)
      return false
    }
  }

  private async getNewTokenAutomatic(): Promise<void> {
    if (!this.auth) throw new Error("Auth not initialized")

    const authUrl = this.auth.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      redirect_uri: `http://localhost:${REDIRECT_PORT}/oauth2callback`,
    })

    console.log("\n========================================")
    console.log("Opening browser for Google authorization...")
    console.log("========================================\n")
    
    // Open browser
    const { exec } = await import("child_process")
    const platform = process.platform
    const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open"
    exec(`${cmd} "${authUrl}"`)

    console.log("If the browser didn't open, visit this URL:")
    console.log(authUrl)
    console.log("\nWaiting for authorization...")

    // Start local server to receive callback
    const code = await this.startLocalServer()
    
    console.log("Authorization received! Getting access token...")
    
    const { tokens } = await this.auth.getToken(code)
    this.auth.setCredentials(tokens)
    
    await fs.mkdir(CONFIG_DIR, { recursive: true })
    await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens))
    console.log("✓ Successfully authenticated with Google Calendar!")
  }

  private startLocalServer(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const parsedUrl = url.parse(req.url || "", true)
          
          if (parsedUrl.pathname === "/oauth2callback") {
            const code = parsedUrl.query.code as string
            
            if (code) {
              // Send success page
              res.writeHead(200, { "Content-Type": "text/html" })
              res.end(`
                <!DOCTYPE html>
                <html>
                <head>
                  <title>LazyCal - Authorization Success</title>
                  <style>
                    body {
                      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                      display: flex;
                      justify-content: center;
                      align-items: center;
                      height: 100vh;
                      margin: 0;
                      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                      color: white;
                    }
                    .container {
                      text-align: center;
                      padding: 2rem;
                      background: rgba(255,255,255,0.1);
                      border-radius: 1rem;
                      backdrop-filter: blur(10px);
                    }
                    h1 { margin: 0 0 1rem 0; }
                    p { margin: 0; opacity: 0.9; }
                    .check { font-size: 4rem; margin-bottom: 1rem; }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <div class="check">✓</div>
                    <h1>Authorization Successful!</h1>
                    <p>You can close this window and return to LazyCal.</p>
                  </div>
                </body>
                </html>
              `)
              
              server.close()
              resolve(code)
            } else {
              res.writeHead(400, { "Content-Type": "text/html" })
              res.end("<h1>Authorization failed</h1><p>No code received.</p>")
              server.close()
              reject(new Error("No authorization code received"))
            }
          }
        } catch (error) {
          server.close()
          reject(error)
        }
      })

      server.listen(REDIRECT_PORT, () => {
        console.log(`Waiting for OAuth callback on port ${REDIRECT_PORT}...`)
      })

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close()
        reject(new Error("Authorization timeout"))
      }, 5 * 60 * 1000)
    })
  }

  async fetchEventsFromCalendars(date: Date, calendarIds: string[]): Promise<CalendarEvent[]> {
    if (!this.calendar) {
      throw new Error("Calendar not initialized")
    }

    const timeMin = startOfWeek(date, { weekStartsOn: 0 }).toISOString()
    const timeMax = endOfWeek(date, { weekStartsOn: 0 }).toISOString()

    const allEvents: CalendarEvent[] = []

    for (const calendarId of calendarIds) {
      try {
        const response = await this.calendar.events.list({
          calendarId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
        })

        const events = response.data.items || []
        
        events.forEach(event => {
          const start = event.start?.dateTime || event.start?.date
          const eventDate = start ? new Date(start) : new Date()
          
          allEvents.push({
            id: event.id || "",
            title: event.summary || "(No title)",
            date: eventDate,
            time: event.start?.dateTime 
              ? this.formatTime(eventDate)
              : undefined,
            description: event.description,
            location: event.location,
            calendarId: calendarId,
          })
        })
      } catch (error) {
        console.error(`Error fetching events from calendar ${calendarId}:`, error)
      }
    }

    return allEvents
  }

  private formatTime(date: Date): string {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  }

  async listCalendars(): Promise<{ id: string; name: string }[]> {
    if (!this.calendar) {
      throw new Error("Calendar not initialized")
    }

    try {
      const response = await this.calendar.calendarList.list()
      const calendars = response.data.items || []
      
      return calendars.map(cal => ({
        id: cal.id || "",
        name: cal.summary || "(No name)",
      }))
    } catch (error) {
      console.error("Error fetching calendars:", error)
      return []
    }
  }
}

// Helper function to generate sample events (fallback when no Google Calendar)
export function generateSampleEvents(): CalendarEvent[] {
  const events: CalendarEvent[] = []
  const today = new Date()
  const titles = [
    "Team Standup",
    "Client Meeting",
    "Code Review",
    "Lunch with Sarah",
    "Project Planning",
    "Design Review",
    "Sprint Retrospective",
    "1:1 with Manager",
    "Demo Presentation",
    "Deployment",
  ]

  // Add some random events
  for (let i = -14; i < 14; i++) {
    if (Math.random() > 0.6) {
      const date = new Date(today)
      date.setDate(today.getDate() + i)
      
      // Random hour between 9 and 17
      const hour = 9 + Math.floor(Math.random() * 8)
      date.setHours(hour, 0, 0, 0)
      
      events.push({
        id: `event-${i}`,
        title: titles[Math.floor(Math.random() * titles.length)],
        date: date,
        time: `${hour.toString().padStart(2, "0")}:00`,
        description: "Sample event description",
      })
    }
  }

  return events
}
