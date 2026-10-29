import { expect, test } from '../support/fixtures';

test('loads a project through a deterministic network boundary', async ({ page, projectFactory }) => {
  // Given a project response and an isolated browser-only harness
  const project = projectFactory.create({
    id: 'project-e2e-001',
    name: 'Durability Spike',
  });
  const endpoint = `https://pmapp.test/api/projects/${project.id}`;

  await page.route(endpoint, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(project),
    });
  });

  await page.setContent(`
    <main>
      <button data-testid="load-project" type="button">Load project</button>
      <article data-testid="project-card" hidden>
        <h1 data-testid="project-name"></h1>
      </article>
    </main>
    <script>
      const button = document.querySelector('[data-testid="load-project"]');
      const card = document.querySelector('[data-testid="project-card"]');
      const name = document.querySelector('[data-testid="project-name"]');

      button.addEventListener('click', async () => {
        const response = await fetch(${JSON.stringify(endpoint)});
        const project = await response.json();
        name.textContent = project.name;
        card.hidden = false;
      });
    </script>
  `);

  // When the user action triggers the request (listener registered first)
  const responsePromise = page.waitForResponse(
    (response) => response.url() === endpoint && response.request().method() === 'GET',
  );
  await page.getByTestId('load-project').click();
  const response = await responsePromise;

  // Then the response and rendered state are both explicit and observable
  expect(response.status()).toBe(200);
  await expect(page.getByTestId('project-card')).toBeVisible();
  await expect(page.getByTestId('project-name')).toHaveText(project.name);
});
