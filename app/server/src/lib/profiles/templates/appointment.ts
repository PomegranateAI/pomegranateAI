import type { ContextProfile } from '../../schemas.js';

/**
 * `appointment` — PLACEHOLDER template (shape: `items`).
 *
 * The structure below (id, shape, kind keys, attrs and the `status` enum,
 * `progress`, source channels) is what the runtime depends on. Every prose
 * string is a minimal working placeholder: replace it with guidance for your
 * own use case. The strings are sent to the capture / routing / review
 * prompts. See docs/llm-calls.md and src/lib/prompt-render.ts.
 */
export const appointmentTemplate: ContextProfile = {
  id: 'appointment',
  name: 'Appointments',
  shape: 'items',
  // PLACEHOLDER
  routing_hint:
    'Appointments: documents that book, confirm, move, or cancel a specific appointment with an ' +
    'agreed date.',
  // PLACEHOLDER
  description:
    'A calendar of booked appointments, one node per appointment. Only extract an appointment ' +
    'with an agreed date; resolve relative dates against today. A reschedule or cancellation ' +
    'amends the existing node instead of creating a new one.',
  kinds: [
    {
      key: 'appointment',
      label: 'Appointment',
      label_plural: 'Appointments',
      color: 4,
      // PLACEHOLDER
      description:
        'One booked appointment. Title: what it is and who it is with. Body: purpose, location, ' +
        'and attendees as the source states them.',
      attrs: [
        {
          key: 'date',
          label: 'Date',
          type: 'date',
          // PLACEHOLDER
          description: 'ISO date of the appointment; omit only if the source gives none.',
        },
        {
          key: 'time',
          label: 'Time',
          type: 'string',
          // PLACEHOLDER
          description: 'Time of day as the source states it; omit if none.',
        },
        {
          key: 'status',
          label: 'Status',
          type: 'enum',
          values: ['scheduled', 'cancelled'],
          required: true,
          // PLACEHOLDER
          description: 'Always set. `scheduled` by default; `cancelled` only when the source says so.',
        },
      ],
      progress: { attr: 'status', settled_values: ['cancelled'] },
    },
  ],
  edges_deliberately_empty: true,
  source_types: [
    {
      key: 'message',
      label: 'Chat message / text',
      description: 'A message that books, confirms, moves, or cancels an appointment.',
      // PLACEHOLDER
      extraction_guidance: 'Read the last message first; only a confirmed time is booked.',
      source_kinds: ['slack'],
    },
    {
      key: 'invite',
      label: 'Calendar invite / confirmation',
      description: 'A calendar invite, booking confirmation, or reminder email.',
      // PLACEHOLDER
      extraction_guidance: 'Take the date, time, and location directly from the invite.',
      source_kinds: ['doc'],
    },
    {
      key: 'conversation',
      label: 'Call or meeting where it was set up',
      description: 'A call, meeting, or transcript in which an appointment gets booked, moved, or cancelled.',
      // PLACEHOLDER
      extraction_guidance: 'Extract only what was agreed, not every time that was floated.',
      source_kinds: ['transcript', 'interaction'],
    },
  ],
  feedback_dimensions: [
    { key: 'currency', label: 'Currency', description: 'whether the draft reflects the latest date, time, and status' },
    { key: 'completeness', label: 'Completeness', description: 'whether every appointment the draft mentions is recorded here' },
  ],
  review_kinds: ['other'],
  query_scopes: [
    { key: 'all', label: 'Everything', kind_keys: 'all' },
    { key: 'appointments', label: 'Appointments', kind_keys: ['appointment'] },
  ],
  flag_semantics: {
    red: 'states a date, time, or status the record contradicts',
    yellow: 'refers to an appointment not recorded here',
    green: 'consistent with what is recorded (default)',
  },
  // PLACEHOLDER
  seed_questions: ['What do I have tomorrow?', 'What appointments are coming up?'],
};
