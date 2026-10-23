import { describe, it, expect } from 'vitest';

/**
 * ATOMIC UNIT: Action Alias Mapping
 * Tests the core alias resolution for common action names
 */

class ActionAliasMapper {
  private static readonly ALIASES = new Map([
    ['write', 'write_file'],
    ['read', 'read_file'],
    ['store', 'remember'],
    ['save', 'remember'],
    ['search', 'recall'],
    ['find', 'recall'],
    ['get', 'recall'],
    ['create', 'create_directory'],
    ['mkdir', 'create_directory'],
    ['list', 'list_directory'],
    ['ls', 'list_directory'],
    ['check', 'exists'],
    ['remove', 'delete'],
    ['rm', 'delete'],
  ]);

  static resolve(action: string): string {
    const alias = this.ALIASES.get(action.toLowerCase());
    return alias || action;
  }

  static hasAlias(action: string): boolean {
    return this.ALIASES.has(action.toLowerCase());
  }

  static getAllAliases(): Map<string, string> {
    return new Map(this.ALIASES);
  }
}

describe('Action Alias Mapper (Atomic Unit)', () => {
  it('should resolve common file operations', () => {
    expect(ActionAliasMapper.resolve('write')).toBe('write_file');
    expect(ActionAliasMapper.resolve('read')).toBe('read_file');
  });

  it('should resolve memory operations', () => {
    expect(ActionAliasMapper.resolve('store')).toBe('remember');
    expect(ActionAliasMapper.resolve('save')).toBe('remember');
    expect(ActionAliasMapper.resolve('search')).toBe('recall');
    expect(ActionAliasMapper.resolve('find')).toBe('recall');
    expect(ActionAliasMapper.resolve('get')).toBe('recall');
  });

  it('should resolve directory operations', () => {
    expect(ActionAliasMapper.resolve('create')).toBe('create_directory');
    expect(ActionAliasMapper.resolve('mkdir')).toBe('create_directory');
    expect(ActionAliasMapper.resolve('list')).toBe('list_directory');
    expect(ActionAliasMapper.resolve('ls')).toBe('list_directory');
  });

  it('should be case-insensitive', () => {
    expect(ActionAliasMapper.resolve('WRITE')).toBe('write_file');
    expect(ActionAliasMapper.resolve('Write')).toBe('write_file');
    expect(ActionAliasMapper.resolve('WrItE')).toBe('write_file');
  });

  it('should return original action if no alias exists', () => {
    expect(ActionAliasMapper.resolve('unknown_action')).toBe('unknown_action');
    expect(ActionAliasMapper.resolve('write_file')).toBe('write_file');
  });

  it('should correctly identify if action has alias', () => {
    expect(ActionAliasMapper.hasAlias('write')).toBe(true);
    expect(ActionAliasMapper.hasAlias('store')).toBe(true);
    expect(ActionAliasMapper.hasAlias('unknown')).toBe(false);
    expect(ActionAliasMapper.hasAlias('write_file')).toBe(false);
  });

  it('should return all aliases', () => {
    const aliases = ActionAliasMapper.getAllAliases();
    expect(aliases.size).toBeGreaterThan(0);
    expect(aliases.get('write')).toBe('write_file');
    expect(aliases.get('store')).toBe('remember');
  });
});

export { ActionAliasMapper };
