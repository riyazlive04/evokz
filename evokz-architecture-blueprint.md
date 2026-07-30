1. Context & Architectural MandateYou are an expert software engineer scaffold engine. You will build Evokz ACE, a multi-tenant B2B automated SaaS built for a marketing agency. The application handles real-time onboarding, automated brand design token extraction, daily custom-scheduled asset generation using Flux.1 via API, Google Drive localized asset synchronization, and WhatsApp media distribution via an Evolution API instance.Core Stack RequirementsFrontend / Fullstack Framework: Next.js 14 (App Router), React 18, Tailwind CSS, Shadcn/ui.Database Layer: PostgreSQL connected through Prisma ORM.AI Infrastructure: Anthropic Claude 3.5 Sonnet (for prompt and copywriting generation).Creative Image Generation Engine: Flux.1 Schnell/Dev via API endpoints (e.g., Together AI or Fal.ai).Media Storage Repository: Google Drive API via a single Central Service Account credential.Communication Gateway: Evolution API (Go-based WhatsApp REST API platform).Payment & Event Trigger Integration: Razorpay Webhooks.2. Technical System Schema & Database BlueprintImplement the following database layer in prisma/schema.prisma. Ensure strict relational constraints, custom indexes, and enumerations.prismadatasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum DeliveryStatus {
  PENDING
  GENERATED
  DELIVERED
  FAILED
}

model Plan {
  id           String   @id @default(uuid())
  name         String   // e.g., "100-Day Blitz", "365-Day Scale"
  durationDays Int
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  clients      Client[]
}

model Category {
  id        String   @id @default(uuid())
  name      String   // e.g., "Real Estate", "Construction"
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  clients   Client[]
}

model Client {
  id              String           @id @default(uuid())
  companyName     String
  whatsappNumber  String           // e.g., "919876543210"
  cronTime        String           @default("09:00") // Client-specific delivery time (HH:MM format)
  startDate       DateTime
  endDate         DateTime
  isActive        Boolean          @default(true)
  brandGuideline  Json?            // Design system extraction parameters
  gDriveFolderId  String?          // Client-isolated Google Drive subfolder ID
  planId          String
  plan            Plan             @relation(fields: [planId], references: [id], onDelete: Restrict)
  categoryId      String
  category        Category         @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  calendarDays    ContentCalendar[]
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  @@index([cronTime, isActive])
}

model ContentCalendar {
  id                String         @id @default(uuid())
  clientId          String
  client            Client         @relation(fields: [clientId], references: [id], onDelete: Cascade)
  dayNumber         Int
  scheduledDate     DateTime
  theme             String
  caption           String         @db.Text
  hashtags          String
  imagePrompt       String         @db.Text
  gDriveFileId      String?        // Storage reference inside Google Drive
  gDriveViewUrl     String?        // Read-only URL to present inside the Admin Dashboard
  deliveryStatus    DeliveryStatus @default(PENDING)
  errorMessage      String?        @db.Text
  createdAt         DateTime       @default(now())
  updatedAt         DateTime       @updatedAt

  @@unique([clientId, dayNumber])
  @@index([scheduledDate, deliveryStatus])
}
Use code with caution.3. Microservice Interface SpecificationsA. Razorpay Event ControllerCreate a secure endpoint at /api/webhooks/razorpay/route.ts.Security Verification: Implement standard HMAC hex signature calculations using your webhook secret passphrase. Reject unauthorized structural anomalies using HTTP 400 responses.Workflow Orchestration: On receiving order.paid:Retrieve transaction details (Metadata variables passed: plan_id, category_id, company_name, phone_number, cron_time).Instantiate a dedicated sandbox subfolder inside Google Drive under a global parent node ("Evokz_Engine_Vault/").Formulate structural execution windows by initializing startDate to now() and updating endDate out to the exact number of days configured on the associated subscription profile.Perform atomic transaction insertions to map out basic customer tracking documents.B. Intelligent Brand Tokenizer EngineCreate a utility class or server action (/lib/ai/brand-tokenizer.ts) that orchestrates Claude 3.5 Sonnet to ingest digital content snippets (such as raw text descriptions, scraping records, style summaries) and structuralize color and font preferences into standard layout configurations.Engine Prompt Constraintsjson{
  "role": "System Structural Architect",
  "task": "Extract raw styling characteristics into structured typography, color schemas, and graphical layouts.",
  "output_format": "Strict RFC-8259 Compliant JSON Object",
  "schema": {
    "colors": [
      {"hex": "String", "role": "primary | secondary | accent | background"}
    ],
    "typography": {
      "headingFont": "String",
      "bodyFont": "String",
      "vibeClassification": "String"
    },
    "layoutDirectives": ["String"]
  }
}
Use code with caution.C. Client-Segmented Multi-Tenant Cron SchedulerSince standard infrastructure cron jobs operate globally on consistent timers, implement an iterative multi-tenant checker running a frequent background cycle (such as an overarching standard hourly cron schedule).typescript// System Logic Representation
async function executeIntervalDispatch() {
  const now = new Date();
  // Format current UTC time or local time to match "HH:MM"
  const currentTimeString = now.toTimeString().slice(0, 5); 

  // Query database targeting items configured precisely to matching current intervals
  const activeQueues = await prisma.client.findMany({
    where: {
      cronTime: currentTimeString,
      isActive: true,
    },
    include: {
      calendarDays: {
        where: {
          scheduledDate: { equals: truncateToDateOnly(now) },
          deliveryStatus: 'PENDING'
        }
      }
    }
  });

  for (const client of activeQueues) {
    for (const day of client.calendarDays) {
      // Trigger background pipeline dispatch execution loops without blocking sequential cycles
      dispatchCreativeTask(client, day);
    }
  }
}
Use code with caution.4. UI/UX Interface GuidelinesDesign the backend control panels using dark glassmorphic environments using Tailwind CSS variables. Incorporate micro-3D transforms (perspective-1000, rotate-x-6) on brand layout panels to display dynamic color palettes, configuration controls, content flows, and operational states clearly.Required Frontend ControlsDynamic Configuration Manager: Comprehensive interfaces to handle standard CRUD workflows on product packages, vertical target segments, and scheduling matrixes.Creative Management Console: Dynamic grid layouts using virtualized layout lists displaying current structural media paths directly out of cached Drive assets without overloading client browser DOM nodes.5. Instructions for Claude Code ExecutionWhen executing these tasks inside your environment terminal, initialize Claude Code and step through these concrete functional implementation routines:bash# Start by validating the database configuration matrices
> "Read prisma/schema.prisma and ensure the architecture handles dynamic custom cron configurations and deep relational linking profiles properly."

# Build out the core incoming infrastructure ingestion logic
> "Generate the Next.js API route located at src/app/api/webhooks/razorpay/route.ts. Include structural signature validation, automated folder generation within Google Drive, and automated customer profile initialization tasks."

# Construct the central orchestration pipeline
> "Build the core system orchestration pipeline wrapper. Ensure it handles step-by-step text prompt extraction via Claude 3.5 Sonnet, asset rendering execution via Flux.1, cloud storage integration inside Drive folders, and message rendering out to destination mobile devices using Evolution API routes."
Use code with caution.6. Edge Case System ResilienceFailures in Content Formatting: Enforce structured JSON schemas when orchestrating requests with Anthropic APIs to prevent conversational output noise from breaking text-parsing routes.Media Engine Timeouts: Wrap graphic production API requests inside structured retry algorithms. If processing times spike, gracefully degrade task pipelines to log warnings and flag items for manual administrator intervention.Handling Webhook Signature Mismatches: Implement robust error logs to flag improper decryption processes without exposing internal system stacks to unauthenticated network actors.7. Next Steps for CustomizationTo help customize this architecture further for your workspace, let me know:What specific API platform you plan to use to interface with Flux.1 (e.g., Replicate, Fal.ai, or Together AI)?If you need the exact Evolution API JSON payload configuration for sending media messages via WhatsApp?If you have an established Next.js UI design system layout or would like Claude Code to generate a boilerplate layout first?