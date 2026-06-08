import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import {
  detectLanguage,
  getSupportedLanguages,
  isLanguageSupported,
  loadGrammarsForLanguages,
} from '../src/extraction/grammars.js';

function nodeLabels(result: ReturnType<typeof extractFromSource>): string[] {
  return result.nodes.map((node) => `${node.kind}:${node.name}`);
}

function refLabels(result: ReturnType<typeof extractFromSource>): string[] {
  return result.unresolvedReferences.map((ref) => `${ref.referenceKind}:${ref.referenceName}`);
}

beforeAll(async () => {
  await loadGrammarsForLanguages(['khn']);
});

describe('BG3 extraction', () => {
  it('detects BG3 resource, stats, KHN, and Osiris file shapes', () => {
    expect(detectLanguage('Mods/Demo/Scripts/anubis/node/Guard.ann')).toBe('bg3_anubis');
    expect(detectLanguage('Mods/Demo/Scripts/anubis/config/Guard.anc')).toBe('bg3_anubis');
    expect(detectLanguage('Public/Shared/RootTemplates/Sword.lsx')).toBe('bg3_resource');
    expect(detectLanguage('Mods/Demo/Localization/English/english.xml')).toBe('bg3_resource');
    expect(detectLanguage('Mods/Demo/Stats/Generated/Data/Status.txt')).toBe('bg3_stats');
    expect(detectLanguage('Mods/Demo/Story/RawFiles/Goals/Init.txt')).toBe('osiris');
    expect(detectLanguage('Mods/Demo/ScriptExtender/Lua/BootstrapClient.khn')).toBe('khn');

    for (const language of ['bg3_anubis', 'bg3_resource', 'bg3_stats', 'khn', 'osiris'] as const) {
      expect(isLanguageSupported(language)).toBe(true);
      expect(getSupportedLanguages()).toContain(language);
    }
  });

  it('extracts BG3 LSX resource nodes and handle/template references', () => {
    const source = `
<save>
  <region id="Templates">
    <node id="GameObjects">
      <children>
        <node id="GameObject">
          <attribute id="UUID" type="FixedString" value="11111111-1111-1111-1111-111111111111" />
          <attribute id="Name" type="LSString" value="MAG_Test_Sword" />
          <attribute id="ParentTemplateId" type="FixedString" value="22222222-2222-2222-2222-222222222222" />
          <attribute id="DisplayName" type="TranslatedString" handle="h123456789abc" />
        </node>
      </children>
    </node>
  </region>
</save>
`;

    const result = extractFromSource('Public/Shared/RootTemplates/Sword.lsx', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toEqual(expect.arrayContaining(['namespace:Templates', 'resource:MAG_Test_Sword']));
    expect(refLabels(result)).toEqual(
      expect.arrayContaining(['references:22222222-2222-2222-2222-222222222222', 'references:h123456789abc']),
    );
  });

  it('extracts BG3 localization handles as resources', () => {
    const source = `
<?xml version="1.0" encoding="utf-8"?>
<contentList>
  <content contentuid="h00a33f75ge607g4aa2ga34ag4e2849aa53f9" version="1">Text <br />Here</content>
</contentList>
`;

    const result = extractFromSource('Mods/Demo/Localization/English/english.xml', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toContain('resource:h00a33f75ge607g4aa2ga34ag4e2849aa53f9');
  });

  it('extracts BG3 JSON resources and nested string references', () => {
    const source = JSON.stringify({
      Name: 'MAG_JSON_Item',
      UUID: '33333333-3333-3333-3333-333333333333',
      ParentTemplateId: '44444444-4444-4444-4444-444444444444',
      Children: [{ Name: 'MAG_JSON_Child', Boosts: 'UnlockSpell(Target_Spell)' }],
      Tags: ['Target_Tag'],
    });

    const result = extractFromSource('Public/Shared/RootTemplates/JsonItem.lsj', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toEqual(expect.arrayContaining(['resource:MAG_JSON_Item', 'resource:MAG_JSON_Child']));
    expect(refLabels(result)).toEqual(
      expect.arrayContaining([
        'references:44444444-4444-4444-4444-444444444444',
        'references:Target_Spell',
        'references:Target_Tag',
      ]),
    );
  });

  it('extracts generic BG3 XML resource tags', () => {
    const source = `
<save>
  <effect Name='FX_Target' class='VisualEffect' Resource='h00a33f75ge607g4aa2ga34ag4e2849aa53f9' />
</save>
`;

    const result = extractFromSource('Public/Shared/Assets/Effects/Test.lsx', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toContain('resource:FX_Target');
    expect(refLabels(result)).toContain('references:h00a33f75ge607g4aa2ga34ag4e2849aa53f9');
  });

  it('skips binary BG3 resource payloads', () => {
    const result = extractFromSource('Public/Shared/RootTemplates/Binary.lsf', 'LSF\u0000payload');

    expect(result.nodes.some((node) => node.kind === 'resource')).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'binary_bg3_resource',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('extracts BG3 Stats entries, inheritance, and data references', () => {
    const source = `
new entry "Target_Status"
type "StatusData"
using "Base_Status"
data "Boosts" "UnlockSpell(Target_Spell);Target_Passive"
add "Target_Tag"
`;

    const result = extractFromSource('Mods/Demo/Stats/Generated/Data/Status.txt', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toContain('resource:Target_Status');
    expect(refLabels(result)).toEqual(
      expect.arrayContaining([
        'extends:Base_Status',
        'references:Target_Spell',
        'references:Target_Passive',
        'references:Target_Tag',
      ]),
    );
  });

  it('keeps BG3 treasure subtables attached to the owning treasure table', () => {
    const source = `
new treasuretable "TUT_Chest_Potions"
CanMerge 1
new subtable "1,1"
object category "I_MY_COOL_NEW_CIRCLET",1,0,0,0,0,0,0,0
`;

    const result = extractFromSource('Public/Demo/Stats/Generated/TreasureTable.txt', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toContain('resource:TUT_Chest_Potions');
    expect(nodeLabels(result)).not.toContain('resource:1,1');
    expect(refLabels(result)).toContain('references:I_MY_COOL_NEW_CIRCLET');
  });

  it('extracts Anubis state scripts, behavior nodes, events, callbacks, and refs', () => {
    const source = `
game.states.Guard = State {
  function ()
    local playerApproachTrigger = Entity("S_EventTrigger_0687d319-0436-4091-8389-15f28536a8e8")
    nodes.GuardAction = Selector {
      function(nodes)
        return FindRandomSelectable(nodes)
      end,
      Valid = function()
        return nearbyPlayer ~= nil
      end
    }
    nodes.GuardAction.Cower = Action {
      function ()
        DebugText(me, "RaiseAlarm")
        Sleep(6.0)
      end
    }
    nodes.Wander = Proxy {
      game.states.GuardWander,
      params = {
        anchor = [[S_WanderArea_a1017cd3-cbde-44f1-b2d9-00572a2dc9c3]]
      },
      OnLeave = function()
        tired = true
      end
    }
    events.EnteredTrigger = function(e)
      if e.Trigger == playerApproachTrigger then
        SetEntityEvent(me, "RaiseAlarm")
      end
    end
  end
}
`;

    const result = extractFromSource('Mods/Demo/Scripts/anubis/node/Guard.ann', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toEqual(
      expect.arrayContaining([
        'module:Guard',
        'method:GuardAction',
        'method:GuardAction.Cower',
        'method:Wander',
        'method:callback:Valid',
        'method:callback:OnLeave',
        'method:event:EnteredTrigger',
      ]),
    );
    expect(refLabels(result)).toEqual(
      expect.arrayContaining([
        'references:S_EventTrigger_0687d319-0436-4091-8389-15f28536a8e8',
        'references:game.states.GuardWander',
        'references:S_WanderArea_a1017cd3-cbde-44f1-b2d9-00572a2dc9c3',
        'references:RaiseAlarm',
        'calls:Entity',
        'calls:FindRandomSelectable',
        'calls:DebugText',
        'calls:Sleep',
        'calls:SetEntityEvent',
      ]),
    );
  });

  it('extracts Anubis config StateRef links', () => {
    const source = `
game.configs.Guard = Config{
  root = StateRef{game.roots.DefaultCharacter,
    genericBehaviours = StateRef{game.states.CrimesHumanoid},
    combat = StateRef{game.states.AlarmGuard_Combat},
    idle = StateRef{game.states.Guard},
  }
}
`;

    const result = extractFromSource('Mods/Demo/Scripts/anubis/config/Guard.anc', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toContain('resource:Guard');
    expect(refLabels(result)).toEqual(
      expect.arrayContaining([
        'references:game.roots.DefaultCharacter',
        'references:game.states.CrimesHumanoid',
        'references:game.states.AlarmGuard_Combat',
        'references:game.states.Guard',
      ]),
    );
  });

  it('extracts KHN helper scripts through the Lua grammar', () => {
    const source = `
function Blooded(entity)
  return HasActiveStatus(entity, "LOW_HITPOINTS")
end
`;

    const result = extractFromSource('Mods/Demo/Scripts/thoth/helpers/Global.khn', source, 'khn');

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toContain('function:Blooded');
    expect(refLabels(result)).toContain('calls:HasActiveStatus');
  });

  it('extracts Osiris goals, rules, DB tables, calls, and string references', () => {
    const source = `
INITSECTION
IF
CharacterUsedSkill(_Player, "Target_Spell", _)
AND
DB_Check(_Player)
THEN
ApplyStatus(_Player, "Target_Status", -1)
DB_Seen(_Player)
`;

    const result = extractFromSource('Mods/Demo/Story/RawFiles/Goals/Init.txt', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toEqual(
      expect.arrayContaining(['module:Init', 'namespace:INIT', 'method:rule:CharacterUsedSkill', 'table:DB_Check']),
    );
    expect(refLabels(result)).toEqual(
      expect.arrayContaining([
        'calls:CharacterUsedSkill',
        'references:DB_Check',
        'calls:ApplyStatus',
        'references:DB_Seen',
        'references:Target_Spell',
        'references:Target_Status',
      ]),
    );
  });

  it('extracts toolkit-style Osiris sections and procedure/query blocks', () => {
    const source = `
INIT:
DB_Characters(S_Player_Astarion_c7c13742-bacd-460a-8f65-f864fe41f255);

KB:
PROC
PROC_Target((CHARACTER)_Character)
AND
QRY_OnlyOnce("Target_Procedure")
THEN
DebugText(_Character, "Target_Status");

QRY
QRY_Target([out](INTEGER)_Result)
THEN
IntegerSum(1, 1, _Result);

EXIT:
NOT DB_Characters(S_Player_Astarion_c7c13742-bacd-460a-8f65-f864fe41f255);
`;

    const result = extractFromSource('Mods/Demo/Story/RawFiles/Goals/ToolkitStyle.txt', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toEqual(
      expect.arrayContaining([
        'namespace:INIT',
        'namespace:KB',
        'namespace:EXIT',
        'method:proc:PROC_Target',
        'method:query:QRY_Target',
      ]),
    );
    expect(refLabels(result)).toEqual(
      expect.arrayContaining([
        'references:DB_Characters',
        'calls:QRY_OnlyOnce',
        'calls:DebugText',
        'calls:IntegerSum',
        'references:Target_Procedure',
        'references:Target_Status',
      ]),
    );
  });

  it('extracts Osiris story header declarations', () => {
    const source = `
alias_type {CHARACTER, 6, 5}
enum_type {TAGCATEGORY, 31, 0, Undefined = 0, Code = 1}
syscall SysCompleteGoal((STRING)_GoalTitle) (1,0,0,0)
sysquery SysStatus([in](STRING)_GoalTitle,[out](INTEGER)_Status) (100,0,0,0)
call RemoveStatus((GUIDSTRING)_Object, (STRING)_Status, (GUIDSTRING)_Cause) (1,0,0,0)
query HasActiveStatus([in](GUIDSTRING)_Object,[in](STRING)_Status,[out](INTEGER)_Bool) (2,0,0,0)
event Unequipped((ITEM)_Item, (CHARACTER)_Character) (3,0,0,0)
`;

    const result = extractFromSource('Mods/Demo/Story/RawFiles/story_header.div', source);

    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toEqual(
      expect.arrayContaining([
        'type_alias:CHARACTER',
        'enum:TAGCATEGORY',
        'enum_member:Undefined',
        'enum_member:Code',
        'function:SysCompleteGoal',
        'function:SysStatus',
        'function:RemoveStatus',
        'function:HasActiveStatus',
        'function:Unequipped',
      ]),
    );
  });
});
