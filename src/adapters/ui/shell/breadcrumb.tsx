/**
 * Breadcrumb Component (Story 2.5 Task 4, FR-10).
 *
 * Renders the path from the project root down to the zoom root.
 * Each crumb is keyboard accessible and allows zooming directly to that ancestor.
 */

import { createElement, type ReactElement } from 'react';
import './breadcrumb.css';

export interface Crumb {
  readonly id: string | null; // null represents project root (clear zoom)
  readonly label: string;
}

export interface BreadcrumbProps {
  readonly crumbs: readonly Crumb[];
  readonly onSelectCrumb: (crumbId: string | null) => void;
}

export function Breadcrumb({ crumbs, onSelectCrumb }: BreadcrumbProps): ReactElement {
  if (crumbs.length <= 1) {
    return createElement('nav', {
      className: 'pm-breadcrumb',
      'aria-label': 'Breadcrumb',
    });
  }

  return createElement(
    'nav',
    {
      className: 'pm-breadcrumb',
      'aria-label': 'Breadcrumb',
    },
    createElement(
      'ol',
      { className: 'pm-breadcrumb__list' },
      crumbs.map((crumb, idx) => {
        const isLast = idx === crumbs.length - 1;
        return createElement(
          'li',
          {
            key: crumb.id ?? 'root',
            className: 'pm-breadcrumb__item',
          },
          isLast
            ? createElement(
                'span',
                {
                  className: 'pm-breadcrumb__current',
                  'aria-current': 'location',
                },
                crumb.label,
              )
            : createElement(
                'button',
                {
                  type: 'button',
                  className: 'pm-breadcrumb__button',
                  onClick: () => onSelectCrumb(crumb.id),
                },
                crumb.label,
              ),
          !isLast &&
            createElement(
              'span',
              { className: 'pm-breadcrumb__separator', 'aria-hidden': 'true' },
              '/',
            ),
        );
      }),
    ),
  );
}
