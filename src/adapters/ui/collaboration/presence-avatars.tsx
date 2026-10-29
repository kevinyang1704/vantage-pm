/**
 * PresenceAvatars — who is in the project now (Story 27.8, TC-FR7, TC-UX2).
 *
 * Initials plus names in text; never color alone. Expired members are already
 * filtered by the pure `presentMembers` helper.
 */

import { initialsFor, type PresenceEntry } from '../../../domain/collaboration/attribution';
import './presence-avatars.css';

export interface PresenceAvatarsProps {
  readonly members: readonly PresenceEntry[];
}

export function PresenceAvatars({ members }: PresenceAvatarsProps): React.ReactElement | null {
  if (members.length === 0) return null;
  const names = members.map((m) => m.actorName).join(', ');
  return (
    <div className="pm-presence" aria-label="Who is here now">
      <span className="pm-presence__summary">{names} {members.length === 1 ? 'is here' : 'are here'}</span>
      <ul className="pm-presence__list">
        {members.map((member) => (
          <li key={member.actorId} className="pm-presence__item">
            <span className="pm-presence__avatar" aria-hidden="true">{initialsFor(member.actorName)}</span>
            <span className="pm-presence__name">{member.actorName}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
