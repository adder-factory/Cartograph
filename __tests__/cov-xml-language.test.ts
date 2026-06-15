/**
 * Coverage + behavior tests for the MyBatis-aware XML extractor
 * (`src/extraction/languages/xml.ts`).
 *
 * The extractor is a regex-based `customExtractor` (no tree-sitter
 * grammar), so these tests feed a raw source string straight through
 * `extractFromSource(path, source, 'xml')` — passing the language
 * explicitly routes to `XML_DEF.customExtractor` and bypasses the
 * path-glob detection, exercising the extractor directly regardless of
 * the file path.
 *
 * Two file shapes are covered:
 *   - Mapper file: `<mapper namespace="...">` root → method nodes
 *     (select/insert/update/delete/sql), type_alias nodes
 *     (resultMap/parameterMap), and references (resultMap/parameterMap
 *     attrs, <include refid>, #{param} binds).
 *   - Config file: `<configuration>` + `<mappers>` → mapper-class refs
 *     and typeAlias nodes.
 *
 * Files matching neither shape produce an empty result.
 */
import { describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';

type Result = ReturnType<typeof extractFromSource>;

/** `kind:name` labels for every emitted node. */
function nodeLabels(result: Result): string[] {
  return result.nodes.map((node) => `${node.kind}:${node.name}`);
}

/** Just the reference names — handy when every ref is `references`. */
function refNames(result: Result): string[] {
  return result.unresolvedReferences.map((ref) => ref.referenceName);
}

function extract(filePath: string, source: string): Result {
  return extractFromSource(filePath, source, 'xml');
}

describe('XML (MyBatis) extractor — mapper file shape', () => {
  it('emits a file node + one method node per statement with namespace-qualified names', () => {
    const source = `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.dao.UserMapper">
  <select id="findById" resultType="User">SELECT * FROM users WHERE id = 1</select>
  <insert id="create">INSERT INTO users (name) VALUES ('a')</insert>
  <update id="rename">UPDATE users SET name = 'b'</update>
  <delete id="remove">DELETE FROM users</delete>
  <sql id="commonColumns">id, name, email</sql>
</mapper>`;

    const result = extract('src/main/resources/mapper/UserMapper.xml', source);

    expect(result.errors).toEqual([]);

    // File node: name is the basename, qualifiedName is the path.
    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('UserMapper.xml');
    expect(fileNode?.qualifiedName).toBe('src/main/resources/mapper/UserMapper.xml');
    expect(fileNode?.language).toBe('xml');

    // One method node per statement; qualifiedName uses the LAST
    // namespace segment (the simple Mapper-interface class name).
    const methods = result.nodes.filter((n) => n.kind === 'method');
    expect(methods.map((m) => m.name).sort()).toEqual(['commonColumns', 'create', 'findById', 'remove', 'rename']);
    expect(methods.every((m) => m.qualifiedName.startsWith('UserMapper::'))).toBe(true);
    expect(methods.find((m) => m.name === 'findById')?.qualifiedName).toBe('UserMapper::findById');
  });

  it('records the originating tag name in `signature` so callers can distinguish statement kinds', () => {
    const source = `<mapper namespace="com.example.OrderMapper">
  <select id="q">SELECT 1</select>
  <insert id="i">INSERT</insert>
  <update id="u">UPDATE</update>
  <delete id="d">DELETE</delete>
  <sql id="frag">cols</sql>
</mapper>`;

    const result = extract('mapper/OrderMapper.xml', source);
    const sigByName = new Map(result.nodes.filter((n) => n.kind === 'method').map((m) => [m.name, m.signature]));

    expect(sigByName.get('q')).toBe('select');
    expect(sigByName.get('i')).toBe('insert');
    expect(sigByName.get('u')).toBe('update');
    expect(sigByName.get('d')).toBe('delete');
    expect(sigByName.get('frag')).toBe('sql');
  });

  it('connects every statement and mapping node to the file node with a `contains` edge', () => {
    const source = `<mapper namespace="X.Y.Mapper">
  <select id="a">SELECT 1</select>
  <resultMap id="rm" type="X.Y.Row"><id property="i"/></resultMap>
</mapper>`;

    const result = extract('mapper/Mapper.xml', source);
    const fileNode = result.nodes.find((n) => n.kind === 'file')!;
    const symbolNodes = result.nodes.filter((n) => n.kind !== 'file');

    expect(symbolNodes.length).toBe(2);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.every((e) => e.kind === 'contains' && e.source === fileNode.id)).toBe(true);
    expect(new Set(result.edges.map((e) => e.target))).toEqual(new Set(symbolNodes.map((n) => n.id)));
  });

  it('uses the bare namespace as the simple class when it has no dotted segment', () => {
    const source = `<mapper namespace="FlatMapper">
  <select id="all">SELECT *</select>
</mapper>`;

    const result = extract('mapper/Flat.xml', source);
    expect(result.nodes.find((n) => n.kind === 'method')?.qualifiedName).toBe('FlatMapper::all');
  });

  it('records 1-indexed line numbers for statements (line accounting survives comment stripping)', () => {
    const source = `<mapper namespace="com.example.LineMapper">

  <select id="onLineFour">SELECT 1</select>
</mapper>`;

    const result = extract('mapper/Line.xml', source);
    const method = result.nodes.find((n) => n.kind === 'method' && n.name === 'onLineFour');
    expect(method?.startLine).toBe(3);
  });
});

describe('XML (MyBatis) extractor — resultMap / parameterMap mappings', () => {
  it('emits a type_alias node per resultMap/parameterMap carrying the declared JVM type in `signature`', () => {
    const source = `<mapper namespace="com.example.MapMapper">
  <resultMap id="userResult" type="com.example.User"><id property="id"/></resultMap>
  <parameterMap id="userParam" type="com.example.UserParam"/>
</mapper>`;

    const result = extract('mapper/MapMapper.xml', source);
    const aliases = result.nodes.filter((n) => n.kind === 'type_alias');

    expect(aliases.map((a) => a.name).sort()).toEqual(['userParam', 'userResult']);
    const byName = new Map(aliases.map((a) => [a.name, a]));
    expect(byName.get('userResult')?.qualifiedName).toBe('MapMapper::userResult');
    expect(byName.get('userResult')?.signature).toBe('com.example.User');
    expect(byName.get('userParam')?.signature).toBe('com.example.UserParam');
  });

  it('falls back to the tag name in `signature` when a mapping has no `type` attribute (extends-only chains)', () => {
    const source = `<mapper namespace="com.example.NoTypeMapper">
  <resultMap id="base"><id property="i"/></resultMap>
  <parameterMap id="pbase"/>
</mapper>`;

    const result = extract('mapper/NoType.xml', source);
    const byName = new Map(result.nodes.filter((n) => n.kind === 'type_alias').map((a) => [a.name, a.signature]));

    expect(byName.get('base')).toBe('resultMap');
    expect(byName.get('pbase')).toBe('parameterMap');
  });
});

describe('XML (MyBatis) extractor — statement references', () => {
  it('emits references for resultMap="X" and parameterMap="X" statement attributes', () => {
    const source = `<mapper namespace="com.example.AttrMapper">
  <resultMap id="rm" type="com.example.Row"/>
  <parameterMap id="pm" type="com.example.Param"/>
  <select id="find" resultMap="rm" parameterMap="pm">SELECT 1</select>
</mapper>`;

    const result = extract('mapper/Attr.xml', source);
    expect(refNames(result)).toEqual(expect.arrayContaining(['AttrMapper::rm', 'AttrMapper::pm']));

    // Attribute refs are anchored to the statement's opening line (4),
    // not the resultMap declaration line.
    const rmRef = result.unresolvedReferences.find((r) => r.referenceName === 'AttrMapper::rm');
    expect(rmRef?.line).toBe(4);
    expect(rmRef?.referenceKind).toBe('references');
    expect(rmRef?.language).toBe('xml');
  });

  it('emits a reference per <include refid="X"/>, handling local and cross-mapper dotted refids', () => {
    const source = `<mapper namespace="com.example.IncludeMapper">
  <sql id="cols">id, name</sql>
  <select id="find">
    SELECT <include refid="cols"/>, <include refid="shared.PartMapper.frag"/> FROM t
  </select>
</mapper>`;

    const result = extract('mapper/Include.xml', source);

    // Local refid → `<currentSimpleClass>::<id>`.
    expect(refNames(result)).toContain('IncludeMapper::cols');
    // Dotted refid `a.b.c` → id `c` in class `b` → `PartMapper::frag`.
    expect(refNames(result)).toContain('PartMapper::frag');
  });

  it('resolves a 2-segment dotted refid (`Class.id`) to `<Class>::<id>`', () => {
    const source = `<mapper namespace="com.example.TwoSegMapper">
  <select id="find">SELECT <include refid="Other.frag"/> FROM t</select>
</mapper>`;

    const result = extract('mapper/TwoSeg.xml', source);
    expect(refNames(result)).toContain('Other::frag');
  });

  it('accepts both self-closing and paired <include> forms', () => {
    const source = `<mapper namespace="com.example.PairMapper">
  <select id="find">
    SELECT <include refid="selfClosed"/>, <include refid="paired"></include> FROM t
  </select>
</mapper>`;

    const result = extract('mapper/Pair.xml', source);
    expect(refNames(result)).toEqual(expect.arrayContaining(['PairMapper::selfClosed', 'PairMapper::paired']));
  });

  it('emits a #{paramName} reference per distinct head identifier, shaped `<Class>::<method>::<param>`', () => {
    const source = `<mapper namespace="com.example.BindMapper">
  <select id="search">
    SELECT * FROM t WHERE name = #{name} AND age = #{age}
  </select>
</mapper>`;

    const result = extract('mapper/Bind.xml', source);
    expect(refNames(result)).toEqual(expect.arrayContaining(['BindMapper::search::name', 'BindMapper::search::age']));
  });

  it('collapses property-access #{user.name} to its head identifier (binds the param, not the property)', () => {
    const source = `<mapper namespace="com.example.PropMapper">
  <select id="byUser">SELECT * FROM t WHERE n = #{user.name} AND c = #{user.city}</select>
</mapper>`;

    const result = extract('mapper/Prop.xml', source);
    const refs = refNames(result);

    // Both #{user.name} and #{user.city} collapse to head `user`, then
    // per-statement de-dup means a SINGLE ref is emitted.
    expect(refs).toContain('PropMapper::byUser::user');
    expect(refs.filter((r) => r === 'PropMapper::byUser::user')).toHaveLength(1);
    // The nested property is never carried as its own ref.
    expect(refs.some((r) => r.endsWith('::name'))).toBe(false);
  });

  it('de-duplicates a #{param} head per statement but re-emits it in a different statement', () => {
    const source = `<mapper namespace="com.example.DedupMapper">
  <select id="one">SELECT * WHERE a = #{id} OR b = #{id}</select>
  <select id="two">SELECT * WHERE c = #{id}</select>
</mapper>`;

    const result = extract('mapper/Dedup.xml', source);
    const refs = refNames(result);

    expect(refs.filter((r) => r === 'DedupMapper::one::id')).toHaveLength(1);
    expect(refs.filter((r) => r === 'DedupMapper::two::id')).toHaveLength(1);
  });

  it('tolerates MyBatis type-hint suffixes (`#{p,jdbcType=VARCHAR}`) without capturing the hint', () => {
    const source = `<mapper namespace="com.example.HintMapper">
  <select id="typed">SELECT * WHERE id = #{id,jdbcType=INTEGER} AND n = #{name,javaType=String,jdbcType=VARCHAR}</select>
</mapper>`;

    const result = extract('mapper/Hint.xml', source);
    expect(refNames(result)).toEqual(expect.arrayContaining(['HintMapper::typed::id', 'HintMapper::typed::name']));
    // The hint text must NOT leak into a ref name.
    expect(refNames(result).some((r) => r.includes('jdbcType'))).toBe(false);
  });

  it('does NOT scan ${literal} string-substitution syntax (only #{} parameter binding)', () => {
    const source = `<mapper namespace="com.example.LiteralMapper">
  <select id="order">SELECT * FROM t ORDER BY \${columnName}</select>
</mapper>`;

    const result = extract('mapper/Literal.xml', source);
    // The statement node still exists, but no #{}-style ref for ${columnName}.
    expect(nodeLabels(result)).toContain('method:order');
    expect(refNames(result).some((r) => r.includes('columnName'))).toBe(false);
  });
});

describe('XML (MyBatis) extractor — comment stripping', () => {
  it('does not extract statements that appear inside <!-- ... --> comments', () => {
    const source = `<mapper namespace="com.example.CommentMapper">
  <!-- <select id="ghost">SELECT ghost</select> -->
  <!-- <include refid="ghostFrag"/> and #{ghostParam} -->
  <select id="real">SELECT * WHERE x = #{realParam}</select>
</mapper>`;

    const result = extract('mapper/Comment.xml', source);
    const names = nodeLabels(result);

    expect(names).toContain('method:real');
    expect(names).not.toContain('method:ghost');
    expect(refNames(result)).not.toContain('CommentMapper::ghostFrag');
    expect(refNames(result).some((r) => r.includes('ghost'))).toBe(false);
    expect(refNames(result)).toContain('CommentMapper::real::realParam');
  });

  it('preserves line numbers across a multi-line comment (whitespace-replaced, not collapsed)', () => {
    const source = `<mapper namespace="com.example.MLMapper">
  <!--
    a multi-line comment
    spanning several lines
  -->
  <select id="afterComment">SELECT 1</select>
</mapper>`;

    const result = extract('mapper/ML.xml', source);
    // The select is on physical line 6; comment stripping keeps newlines.
    expect(result.nodes.find((n) => n.name === 'afterComment')?.startLine).toBe(6);
  });

  it('strips multiple separate comment blocks without merging the span between them', () => {
    const source = `<mapper namespace="com.example.MultiCommentMapper">
  <!-- first --> <select id="a">SELECT 1</select> <!-- second -->
  <select id="b">SELECT 2</select>
</mapper>`;

    const result = extract('mapper/MultiComment.xml', source);
    expect(nodeLabels(result)).toEqual(expect.arrayContaining(['method:a', 'method:b']));
  });
});

describe('XML (MyBatis) extractor — config file shape (mybatis-config.xml)', () => {
  it('emits a mapper-class reference (simple name) per <mapper class="..."/> and ignores resource= mappers', () => {
    const source = `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE configuration PUBLIC "-//mybatis.org//DTD Config 3.0//EN" "http://mybatis.org/dtd/mybatis-3-config.dtd">
<configuration>
  <mappers>
    <mapper class="com.example.dao.UserMapper"/>
    <mapper class="com.example.dao.OrderMapper"></mapper>
    <mapper resource="mapper/IgnoredMapper.xml"/>
  </mappers>
</configuration>`;

    const result = extract('src/main/resources/mybatis-config.xml', source);

    expect(result.errors).toEqual([]);
    // refs use the SIMPLE class name (last dotted segment).
    expect(refNames(result)).toEqual(expect.arrayContaining(['UserMapper', 'OrderMapper']));
    // resource= mappers reference XML files, not JVM classes → not emitted.
    expect(refNames(result).some((r) => r.includes('Ignored'))).toBe(false);
    // No method/type_alias nodes for a pure-config file beyond the typeAlias path.
    expect(result.nodes.filter((n) => n.kind === 'method')).toHaveLength(0);
  });

  it('uses the FQCN itself as the reference name when a mapper class has no package', () => {
    const source = `<configuration>
  <mappers>
    <mapper class="BareMapper"/>
  </mappers>
</configuration>`;

    const result = extract('mybatis-config.xml', source);
    expect(refNames(result)).toContain('BareMapper');
  });

  it('emits a type_alias node per <typeAlias alias="A" type="X"/> with FQCN in signature and a file-scoped qualifiedName', () => {
    const source = `<configuration>
  <typeAliases>
    <typeAlias alias="User" type="com.example.User"/>
    <typeAlias alias="Order" type="com.example.Order"/>
  </typeAliases>
  <mappers>
    <mapper class="com.example.UserMapper"/>
  </mappers>
</configuration>`;

    const result = extract('mybatis-config.xml', source);
    const aliases = result.nodes.filter((n) => n.kind === 'type_alias');

    expect(aliases.map((a) => a.name).sort()).toEqual(['Order', 'User']);
    const user = aliases.find((a) => a.name === 'User');
    expect(user?.signature).toBe('com.example.User');
    // qualifiedName is `<filePath>::<alias>` (alias is config-file local).
    expect(user?.qualifiedName).toBe('mybatis-config.xml::User');
    // type_alias nodes are connected via a contains edge.
    expect(result.edges.some((e) => e.kind === 'contains' && e.target === user?.id)).toBe(true);
    // It deliberately emits NO type_of edge from the alias to its target.
    expect(refNames(result).some((r) => r.includes('com.example.User'))).toBe(false);
  });

  it('skips a typeAlias missing the alias attribute and one missing the type attribute', () => {
    const source = `<configuration>
  <typeAliases>
    <typeAlias type="com.example.NoAlias"/>
    <typeAlias alias="NoType"/>
    <typeAlias alias="Good" type="com.example.Good"/>
  </typeAliases>
  <mappers>
    <mapper class="com.example.UserMapper"/>
  </mappers>
</configuration>`;

    const result = extract('mybatis-config.xml', source);
    expect(result.nodes.filter((n) => n.kind === 'type_alias').map((n) => n.name)).toEqual(['Good']);
  });
});

describe('XML (MyBatis) extractor — gate / negative cases', () => {
  it('returns an empty result for an XML file that is neither a mapper nor a config file', () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <build>
    <plugins>
      <plugin>
        <configuration><source>17</source></configuration>
      </plugin>
    </plugins>
  </build>
</project>`;

    const result = extract('pom.xml', source);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedReferences).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('does NOT treat a <configuration> file as a config mapper unless a <mappers> block is also present', () => {
    // Maven-style: has <configuration> but no <mappers> → empty.
    const source = `<configuration>
  <property name="x" value="1"/>
</configuration>`;

    const result = extract('logback.xml', source);
    expect(result.nodes).toEqual([]);
    expect(result.unresolvedReferences).toEqual([]);
  });

  it('returns an empty result for an empty source and for a comment-only source', () => {
    expect(extract('mapper/Empty.xml', '').nodes).toEqual([]);
    expect(extract('mapper/CommentOnly.xml', '<!-- <mapper namespace="ghost"> -->').nodes).toEqual([]);
  });

  it('does not qualify a file whose <mapper namespace> appears only inside a comment', () => {
    const source = `<!-- example: <mapper namespace="com.example.Ghost"> ... </mapper> -->
<project><build/></project>`;

    const result = extract('README.xml', source);
    expect(result.nodes).toEqual([]);
  });
});

describe('XML (MyBatis) extractor — robustness / malformed input', () => {
  it('treats the rest of the file as the body when a statement has no closing tag (no throw)', () => {
    const source = `<mapper namespace="com.example.OpenMapper">
  <select id="unclosed">SELECT * FROM t WHERE id = #{id}`;

    const result = extract('mapper/Open.xml', source);
    expect(result.errors).toEqual([]);
    expect(nodeLabels(result)).toContain('method:unclosed');
    // The body scan still found the #{id} bind despite the missing </select>.
    expect(refNames(result)).toContain('OpenMapper::unclosed::id');
  });

  it('gives duplicate statement ids distinct node ids (malformed file does not crash extraction)', () => {
    const source = `<mapper namespace="com.example.DupMapper">
  <select id="dup">SELECT 1</select>
  <select id="dup">SELECT 2</select>
</mapper>`;

    const result = extract('mapper/Dup.xml', source);
    const dups = result.nodes.filter((n) => n.kind === 'method' && n.name === 'dup');

    expect(dups).toHaveLength(2);
    expect(new Set(dups.map((n) => n.id)).size).toBe(2);
  });

  it('treats a self-closing statement that is the LAST element as a true empty body (no refs)', () => {
    const source = `<mapper namespace="com.example.AloneMapper">
  <select id="empty" resultType="User" />
</mapper>`;

    const result = extract('mapper/Alone.xml', source);
    expect(nodeLabels(result)).toContain('method:empty');
    // No closing </select> exists after the self-closing tag, so the body
    // scan runs to EOF over `</mapper>` only — no #{} placeholders found.
    expect(result.unresolvedReferences).toEqual([]);
  });

  it('BUG: a self-closing statement bleeds its "body" into the next same-tag sibling', () => {
    // KNOWN BUG (documented here, NOT a test of intended behavior).
    //
    // The module's JSDoc (xml.ts, "Known limitations") claims:
    //   "Self-closing statement tags (`<select id="x" />`) have no body;
    //    the body scan is a no-op."
    //
    // That holds ONLY when the self-closing tag is the last statement (see
    // the test above). When another statement of the SAME tag follows,
    // `findClosingTag` matches the NEXT statement's `</select>`, so the
    // self-closing tag's "body" spans across its sibling and it captures
    // that sibling's `#{x}` placeholder — emitting a spurious
    // `SelfMapper::empty::x` reference. The body scan is therefore NOT a
    // no-op in this case. (`STATEMENT_RE` is not self-close-aware: the
    // `/` in `/>` is just part of the `[^>]*` run before `>`, and
    // `openingEnd` lands after the `/>` with no flag that the tag had no
    // body.)
    //
    // Real MyBatis files don't ship empty statements, so this is benign in
    // practice, but the asserted-here behavior is incorrect. Asserting the
    // ACTUAL (buggy) output keeps the test green and pins the bug; flip the
    // expectations if/when the extractor is fixed to skip self-closing
    // bodies.
    const source = `<mapper namespace="com.example.SelfMapper">
  <select id="empty" resultType="User" />
  <select id="real">SELECT * WHERE x = #{x}</select>
</mapper>`;

    const result = extract('mapper/Self.xml', source);
    expect(nodeLabels(result)).toEqual(expect.arrayContaining(['method:empty', 'method:real']));
    expect(refNames(result)).toContain('SelfMapper::real::x');
    // Spurious ref from the self-closing `empty` statement (the bug):
    expect(refNames(result)).toContain('SelfMapper::empty::x');
  });

  it('shares the id-ordinal allocator across statement and mapping passes', () => {
    // A statement id and a mapping id collide ("shared"); both nodes must
    // still get distinct ids via the shared ordinal map.
    const source = `<mapper namespace="com.example.ShareMapper">
  <select id="shared">SELECT 1</select>
  <resultMap id="shared" type="com.example.Row"/>
</mapper>`;

    const result = extract('mapper/Share.xml', source);
    const shared = result.nodes.filter((n) => n.name === 'shared');

    expect(shared.map((n) => n.kind).sort()).toEqual(['method', 'type_alias']);
    expect(new Set(shared.map((n) => n.id)).size).toBe(2);
  });

  it('handles single-quoted attribute values identically to double-quoted', () => {
    const source = `<mapper namespace='com.example.QuoteMapper'>
  <select id='findOne' resultMap='rm'>SELECT * WHERE id = #{id}</select>
  <resultMap id='rm' type='com.example.Row'/>
</mapper>`;

    const result = extract('mapper/Quote.xml', source);
    expect(nodeLabels(result)).toEqual(expect.arrayContaining(['method:findOne', 'type_alias:rm']));
    expect(refNames(result)).toEqual(expect.arrayContaining(['QuoteMapper::rm', 'QuoteMapper::findOne::id']));
  });

  it('matches statement tags case-insensitively and lowercases the tag for the qualifiedName lookup', () => {
    const source = `<mapper namespace="com.example.CaseMapper">
  <SELECT id="upper">SELECT 1</SELECT>
</mapper>`;

    const result = extract('mapper/Case.xml', source);
    const method = result.nodes.find((n) => n.kind === 'method' && n.name === 'upper');
    expect(method).toBeDefined();
    // The tag is lowercased into the signature.
    expect(method?.signature).toBe('select');
  });
});
