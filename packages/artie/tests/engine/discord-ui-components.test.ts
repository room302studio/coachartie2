import { describe, it, expect } from 'vitest';
import { discordUICapability } from '../../src/engine/tools/discord/ui.js';
import { takePendingComponents } from '../../src/engine/1-intake/pending-components.js';

const handler = discordUICapability.handler;

describe('discord-ui: buttons with a turn id queue instead of returning DISCORD_UI:', () => {
  it('returns a short plain result and queues the action row for the turn', async () => {
    const turnId = 'turn-buttons-1';
    const result = await handler(
      { action: 'buttons', buttons: [{ label: 'Yes' }, { label: 'No' }] },
      undefined,
      { messageId: turnId }
    );

    expect(result).not.toContain('DISCORD_UI:');
    expect(result).toContain('2 buttons will appear under your reply');
    expect(result).toContain('Yes / No');

    const rows = takePendingComponents(turnId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as any;
    expect(row.type).toBe(1);
    expect(row.components).toHaveLength(2);
    expect(row.components[0].label).toBe('Yes');
    expect(row.components[0].custom_id).toMatch(/^artie:[^:]+:0$/);
    expect(row.components[1].custom_id).toMatch(/^artie:[^:]+:1$/);
    // the model never supplies the custom_id — it's always server-built
    expect(row.components[0].custom_id).toContain(turnId.slice(-12));
  });

  it('singular phrasing for exactly one button', async () => {
    const turnId = 'turn-buttons-singular';
    const result = await handler(
      { action: 'buttons', buttons: [{ label: 'OK' }] },
      undefined,
      { messageId: turnId }
    );
    expect(result).toContain('1 button will appear under your reply: OK');
    takePendingComponents(turnId); // drain
  });

  it('falls back to the legacy DISCORD_UI: marker when there is no turn id (push-worker path)', async () => {
    const result = await handler(
      { action: 'buttons', buttons: [{ label: 'Yes' }, { label: 'No' }] },
      undefined,
      undefined
    );
    expect(result).toMatch(/^DISCORD_UI:BUTTONS:/);
    expect(result).toContain('Created 2 interactive buttons!');
  });

  it('clamps to 5 rows of 5 buttons (25 max) and drops the rest', async () => {
    const turnId = 'turn-buttons-clamp';
    const buttons = Array.from({ length: 30 }, (_, i) => ({ label: `B${i}` }));
    await handler({ action: 'buttons', buttons }, undefined, { messageId: turnId });
    const rows = takePendingComponents(turnId) as any[];
    expect(rows).toHaveLength(5);
    const totalButtons = rows.reduce((sum, row) => sum + row.components.length, 0);
    expect(totalButtons).toBe(25);
    for (const row of rows) {
      expect(row.components.length).toBeLessThanOrEqual(5);
    }
  });

  it('truncates an overlong label to 80 chars', async () => {
    const turnId = 'turn-buttons-longlabel';
    const longLabel = 'x'.repeat(200);
    await handler({ action: 'buttons', buttons: [{ label: longLabel }] }, undefined, {
      messageId: turnId,
    });
    const rows = takePendingComponents(turnId) as any[];
    expect(rows[0].components[0].label.length).toBe(80);
  });

  it('drops a button with no label instead of throwing', async () => {
    const turnId = 'turn-buttons-nolabel';
    const result = await handler(
      { action: 'buttons', buttons: [{ label: '' }, { label: 'Keep me' }] },
      undefined,
      { messageId: turnId }
    );
    expect(result).toContain('1 button will appear');
    const rows = takePendingComponents(turnId) as any[];
    expect(rows[0].components).toHaveLength(1);
    expect(rows[0].components[0].label).toBe('Keep me');
  });

  it('an unrecognized style falls back to secondary', async () => {
    const turnId = 'turn-buttons-badstyle';
    await handler(
      { action: 'buttons', buttons: [{ label: 'X', style: 'rainbow' }] },
      undefined,
      { messageId: turnId }
    );
    const rows = takePendingComponents(turnId) as any[];
    // ButtonStyle.Secondary === 2
    expect(rows[0].components[0].style).toBe(2);
  });

  it('a link button needs an http(s) url and gets no custom_id', async () => {
    const turnId = 'turn-buttons-link';
    await handler(
      {
        action: 'buttons',
        buttons: [{ label: 'Docs', style: 'link', url: 'https://example.com' } as any],
      },
      undefined,
      { messageId: turnId }
    );
    const rows = takePendingComponents(turnId) as any[];
    expect(rows[0].components[0].url).toBe('https://example.com');
    expect(rows[0].components[0].custom_id).toBeUndefined();
  });

  it('a link button without a valid url is dropped entirely', async () => {
    const turnId = 'turn-buttons-badlink';
    const result = await handler(
      {
        action: 'buttons',
        buttons: [
          { label: 'Bad link', style: 'link', url: 'not-a-url' } as any,
          { label: 'Good', style: 'primary' },
        ],
      },
      undefined,
      { messageId: turnId }
    );
    expect(result).toContain('1 button will appear');
    const rows = takePendingComponents(turnId) as any[];
    expect(rows[0].components).toHaveLength(1);
    expect(rows[0].components[0].label).toBe('Good');
  });

  it('throws a clear error when every button is invalid', async () => {
    await expect(
      handler({ action: 'buttons', buttons: [{ label: '' }] }, undefined, {
        messageId: 'turn-buttons-allbad',
      })
    ).rejects.toThrow(/No valid buttons/);
  });
});

describe('discord-ui: select with a turn id', () => {
  it('queues one action row with a select menu, custom_id artie:<turn>:0', async () => {
    const turnId = 'turn-select-1';
    const result = await handler(
      {
        action: 'select',
        options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }],
      },
      undefined,
      { messageId: turnId }
    );
    expect(result).not.toContain('DISCORD_UI:');
    expect(result).toContain('A dropdown with 2 options will appear under your reply');

    const rows = takePendingComponents(turnId) as any[];
    expect(rows).toHaveLength(1);
    const select = rows[0].components[0];
    expect(select.type).toBe(3);
    expect(select.custom_id).toMatch(/^artie:[^:]+:0$/);
    expect(select.options).toHaveLength(2);
  });

  it('clamps options to 25', async () => {
    const turnId = 'turn-select-clamp';
    const options = Array.from({ length: 40 }, (_, i) => ({ label: `O${i}`, value: `v${i}` }));
    await handler({ action: 'select', options }, undefined, { messageId: turnId });
    const rows = takePendingComponents(turnId) as any[];
    expect(rows[0].components[0].options).toHaveLength(25);
  });

  it('falls back to the legacy DISCORD_UI: marker with no turn id', async () => {
    const result = await handler(
      { action: 'select', options: [{ label: 'Red', value: 'red' }] },
      undefined,
      undefined
    );
    expect(result).toMatch(/^DISCORD_UI:SELECT:/);
  });
});

describe('discord-ui: modal/context-menu are honest, not success claims', () => {
  it('modal result says it cannot attach to a plain reply', async () => {
    const result = await handler(
      { action: 'modal', title: 'Form', inputs: [{ label: 'Name' }] },
      undefined,
      { messageId: 'turn-modal' }
    );
    expect(result).toMatch(/^DISCORD_UI:MODAL:/);
    expect(result.toLowerCase()).toContain("can't appear on a plain chat reply");
    expect(result.toLowerCase()).not.toContain('waiting for user interaction');
  });

  it('context-menu result says it is not registered yet', async () => {
    const result = await handler({ action: 'context-menu', name: 'Analyze' }, undefined, {
      messageId: 'turn-ctx',
    });
    expect(result).toMatch(/^DISCORD_UI:CONTEXT_MENU:/);
    expect(result.toLowerCase()).toContain('needs to be registered');
  });
});

describe('discord-ui: params as the native tool loop sends them (all strings), 2026-11-24', () => {
  it('"A | B" labels become buttons', async () => {
    const turnId = 'turn-native-buttons';
    const result = await handler({ action: 'buttons', buttons: 'Ship it | Hold' }, undefined, { messageId: turnId });
    expect(result).toContain('2 buttons will appear under your reply: Ship it / Hold');
    takePendingComponents(turnId);
  });

  it('a JSON-string buttons array keeps styles', async () => {
    const turnId = 'turn-native-json';
    await handler({ action: 'buttons', buttons: '[{"label":"Go","style":"success"}]' }, undefined, { messageId: turnId });
    const row = takePendingComponents(turnId)[0] as any;
    expect(row.components[0].style).toBe(3);
  });

  it('the legacy data string still works', async () => {
    const turnId = 'turn-native-data';
    const result = await handler({ action: 'buttons', data: '[{"label":"Yes"},{"label":"No"}]' }, undefined, {
      messageId: turnId,
    });
    expect(result).toContain('Yes / No');
    takePendingComponents(turnId);
  });

  it('a multi select lets people pick several', async () => {
    const turnId = 'turn-native-select';
    await handler({ action: 'select', options: 'Tokyo | Berlin | NYC', multi: 'true' }, undefined, { messageId: turnId });
    const menu = (takePendingComponents(turnId)[0] as any).components[0];
    expect(menu.max_values).toBe(3);
    expect(menu.options.map((o: any) => o.value)).toEqual(['Tokyo', 'Berlin', 'NYC']);
  });

  it('declares the params the model needs (the scraped schema offered only an unread `data`)', () => {
    expect(discordUICapability.actions?.buttons.params?.buttons.required).toBe(true);
    expect(discordUICapability.actions?.select.params?.multi.type).toBe('boolean');
  });
});
