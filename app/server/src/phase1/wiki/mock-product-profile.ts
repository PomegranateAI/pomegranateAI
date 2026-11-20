import { ContextProfile } from '../../lib/schemas.js';

// Minimal stand-in for the removed 'product' builtin profile — just enough
// shape (kinds the wiki tests address by key, one query scope, one feedback
// dimension) to satisfy ContextProfile, not a real template.
export const productProfile: ContextProfile = {
  id: 'product',
  name: 'Product',
  description: 'A mock product profile',
  shape: 'items',
  kinds: [
    { key: 'goal', label: 'Goal', label_plural: 'Goals', color: 1, description: '' },
    { key: 'decision', label: 'Decision', label_plural: 'Decisions', color: 2, description: '' },
    { key: 'person', label: 'Person', label_plural: 'People', color: 3, description: '' },
    { key: 'research', label: 'Research', label_plural: 'Research', color: 4, description: '' },
    { key: 'feature', label: 'Feature', label_plural: 'Features', color: 5, description: '' },
    { key: 'meeting', label: 'Meeting', label_plural: 'Meetings', color: 6, description: '' },
  ],
  extraction_groups: [
    { key: 'planning', label: 'Planning', kind_keys: ['goal', 'decision', 'research'], description: '' },
    { key: 'people', label: 'People', kind_keys: ['person'], description: '' },
    { key: 'product', label: 'Product', kind_keys: ['feature', 'meeting'], description: '' },
  ],
  feedback_dimensions: [{ key: 'accuracy', label: 'Accuracy', description: '' }],
  review_kinds: ['other'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: { red: '', yellow: '', green: '' },
  seed_questions: [],
};
