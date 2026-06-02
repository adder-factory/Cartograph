/**
 * B11/F#64b (2026-05-26) — MyBatis Java↔XML linkage end-to-end test.
 *
 * Indexes a minimal MyBatis project (Java Mapper interface + XML
 * mapper file), then verifies:
 *   - The XML extractor emits one `kind:'method'` node per
 *     `<select|insert|update|delete|sql>` element with
 *     `qualifiedName = '<LastNamespaceSegment>::<id>'`.
 *   - The `mybatis-binding` hook emits a `references` edge from each
 *     Java/Kotlin Mapper method to the matching XML statement.
 *   - Non-MyBatis XML files (e.g. `pom.xml`) produce zero symbols.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

describe('MyBatis Java<->XML binding (B11/F#64b)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mybatis-'));
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('emits one method node per MyBatis statement with <Class>::<id> qualifiedName', async () => {
    // Use a MyBatis-conventional path (`mapper/`) so XML_DEF's
    // narrowed include globs match. Putting the file at the tempDir
    // root would skip extraction.
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.UserMapper">
  <select id="findById" parameterType="long" resultType="User">
    SELECT * FROM users WHERE id = #{id}
  </select>
  <insert id="insert" parameterType="User">
    INSERT INTO users (name) VALUES (#{name})
  </insert>
  <update id="updateName">
    UPDATE users SET name = #{name} WHERE id = #{id}
  </update>
  <delete id="deleteById">
    DELETE FROM users WHERE id = #{id}
  </delete>
  <sql id="commonColumns">id, name, created_at</sql>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const xmlMethods = getNodesByKind(cg.queries, 'method').filter((m) => m.language === 'xml');
    const names = xmlMethods.map((m) => m.qualifiedName).sort(byString);
    expect(names).toEqual([
      'UserMapper::commonColumns',
      'UserMapper::deleteById',
      'UserMapper::findById',
      'UserMapper::insert',
      'UserMapper::updateName',
    ]);

    // The signature carries the tag kind so a downstream lens can tell
    // a `<select>` from an `<insert>` without re-parsing the XML.
    const findById = xmlMethods.find((m) => m.name === 'findById');
    expect(findById?.signature).toBe('select');
    const insertStmt = xmlMethods.find((m) => m.name === 'insert');
    expect(insertStmt?.signature).toBe('insert');
    const sqlFragment = xmlMethods.find((m) => m.name === 'commonColumns');
    expect(sqlFragment?.signature).toBe('sql');
  });

  it('emits no method nodes for non-MyBatis XML files (gate works)', async () => {
    // Drop a non-MyBatis XML at a MyBatis-shaped path so include
    // globs DO match — the gate is in the extractor (MYBATIS_ROOT_RE
    // check), not the glob. This proves the extractor short-circuits
    // when the root element isn't `<mapper namespace="...">`.
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'pom.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>app</artifactId>
  <version>1.0.0</version>
</project>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const xmlMethods = getNodesByKind(cg.queries, 'method').filter((m) => m.language === 'xml');
    expect(xmlMethods.length).toBe(0);
  });

  it('links Java Mapper method to the matching XML statement', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'UserMapper.java'),
      `package com.example;
public interface UserMapper {
  User findById(long id);
  void insert(User u);
}
`,
    );
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<?xml version="1.0" encoding="UTF-8" ?>
<mapper namespace="com.example.UserMapper">
  <select id="findById" resultType="User">SELECT * FROM users WHERE id = #{id}</select>
  <insert id="insert">INSERT INTO users (name) VALUES (#{name})</insert>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const javaMethods = getNodesByKind(cg.queries, 'method').filter((m) => m.language === 'java');
    const findByIdJava = javaMethods.find((m) => m.name === 'findById');
    const insertJava = javaMethods.find((m) => m.name === 'insert');
    expect(findByIdJava).toBeDefined();
    expect(insertJava).toBeDefined();

    const xmlMethods = getNodesByKind(cg.queries, 'method').filter((m) => m.language === 'xml');
    const findByIdXml = xmlMethods.find((m) => m.name === 'findById');
    const insertXml = xmlMethods.find((m) => m.name === 'insert');
    expect(findByIdXml).toBeDefined();
    expect(insertXml).toBeDefined();

    const findByIdEdges = getOutgoingEdges(cg.queries, findByIdJava!.id).filter(
      (e) => e.kind === 'references' && e.target === findByIdXml!.id,
    );
    expect(findByIdEdges.length).toBe(1);
    expect(findByIdEdges[0]!.metadata?.synthesizedBy).toBe('mybatis-binding');

    const insertEdges = getOutgoingEdges(cg.queries, insertJava!.id).filter(
      (e) => e.kind === 'references' && e.target === insertXml!.id,
    );
    expect(insertEdges.length).toBe(1);
  });

  it('does not emit a Java<->XML edge when names do not match', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'OtherMapper.java'),
      `package com.example;
public interface OtherMapper {
  Object somethingElse();
}
`,
    );
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <select id="findById">SELECT 1</select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const somethingElse = getNodesByKind(cg.queries, 'method').find(
      (m) => m.language === 'java' && m.name === 'somethingElse',
    );
    expect(somethingElse).toBeDefined();
    // No mybatis-binding edge from somethingElse — class names differ.
    const edges = getOutgoingEdges(cg.queries, somethingElse!.id).filter(
      (e) => e.metadata?.synthesizedBy === 'mybatis-binding',
    );
    expect(edges.length).toBe(0);
  });

  it('handles a multi-statement Mapper across files', async () => {
    const javaDir = path.join(tempDir, 'src', 'main', 'java', 'com', 'example');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.writeFileSync(
      path.join(javaDir, 'OrderMapper.java'),
      `package com.example;
public interface OrderMapper {
  Order findById(long id);
  java.util.List<Order> findAll();
  void create(Order o);
  void deleteById(long id);
}
`,
    );

    const resourcesDir = path.join(tempDir, 'src', 'main', 'resources', 'mapper');
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(
      path.join(resourcesDir, 'OrderMapper.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.OrderMapper">
  <select id="findById" resultType="Order">SELECT * FROM orders WHERE id = #{id}</select>
  <select id="findAll" resultType="Order">SELECT * FROM orders</select>
  <insert id="create" parameterType="Order">INSERT INTO orders ...</insert>
  <delete id="deleteById">DELETE FROM orders WHERE id = #{id}</delete>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const javaMethods = getNodesByKind(cg.queries, 'method').filter(
      (m) => m.language === 'java' && m.qualifiedName.startsWith('OrderMapper::'),
    );
    expect(javaMethods.length).toBe(4);

    // Every Java method on OrderMapper should have a mybatis-binding
    // edge to the matching XML statement.
    for (const javaMethod of javaMethods) {
      const edges = getOutgoingEdges(cg.queries, javaMethod.id).filter(
        (e) => e.metadata?.synthesizedBy === 'mybatis-binding',
      );
      expect(edges.length, `Java method ${javaMethod.qualifiedName} should bind to XML`).toBe(1);
    }
  });

  // ── v1.1 (2026-05-27): resultMap + <include refid> support ──

  it('emits a type_alias node per <resultMap> with the declared type as signature', async () => {
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <resultMap id="userResult" type="com.example.User">
    <id column="id" property="id"/>
    <result column="name" property="name"/>
  </resultMap>
  <parameterMap id="userParams" type="com.example.User"/>
  <resultMap id="legacyResult">
    <result column="x" property="x"/>
  </resultMap>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const typeAliases = getNodesByKind(cg.queries, 'type_alias').filter((n) => n.language === 'xml');
    const byName = new Map(typeAliases.map((n) => [n.name, n]));

    expect(byName.has('userResult')).toBe(true);
    expect(byName.get('userResult')?.qualifiedName).toBe('UserMapper::userResult');
    expect(byName.get('userResult')?.signature).toBe('com.example.User');

    expect(byName.has('userParams')).toBe(true);
    expect(byName.get('userParams')?.signature).toBe('com.example.User');

    // Missing `type` attribute → signature falls back to the tag label
    // ('resultMap'), not undefined / empty.
    expect(byName.has('legacyResult')).toBe(true);
    expect(byName.get('legacyResult')?.signature).toBe('resultMap');
  });

  it('resolves <include refid="local"/> to the <sql> fragment in the same mapper', async () => {
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <sql id="commonColumns">id, name, created_at</sql>
  <select id="findById" resultType="User">
    SELECT <include refid="commonColumns"/> FROM users WHERE id = #{id}
  </select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const xmlMethods = getNodesByKind(cg.queries, 'method').filter((m) => m.language === 'xml');
    const sqlFrag = xmlMethods.find((m) => m.name === 'commonColumns');
    const findByIdStmt = xmlMethods.find((m) => m.name === 'findById');
    expect(sqlFrag).toBeDefined();
    expect(findByIdStmt).toBeDefined();

    // The xml extractor emits an UnresolvedReference with referenceName
    // = 'UserMapper::commonColumns'; the standard resolver's
    // qualifiedName-match path resolves it (resolvedBy:
    // 'qualified-name', confidence 0.95) — no mybatis-binding sub-pass
    // is needed. We only assert the edge exists, not its provenance.
    const edges = getOutgoingEdges(cg.queries, findByIdStmt!.id).filter(
      (e) => e.kind === 'references' && e.target === sqlFrag!.id,
    );
    expect(edges.length).toBe(1);
  });

  it('resolves <include refid="OtherMapper.frag"/> cross-mapper', async () => {
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'OtherMapper.xml'),
      `<mapper namespace="com.example.OtherMapper">
  <sql id="sharedColumns">id, code</sql>
</mapper>
`,
    );
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <select id="findOne" resultType="User">
    SELECT <include refid="com.example.OtherMapper.sharedColumns"/> FROM users LIMIT 1
  </select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const xmlMethods = getNodesByKind(cg.queries, 'method').filter((m) => m.language === 'xml');
    const sharedColumns = xmlMethods.find((m) => m.qualifiedName === 'OtherMapper::sharedColumns');
    const findOne = xmlMethods.find((m) => m.qualifiedName === 'UserMapper::findOne');
    expect(sharedColumns).toBeDefined();
    expect(findOne).toBeDefined();

    const edges = getOutgoingEdges(cg.queries, findOne!.id).filter(
      (e) => e.kind === 'references' && e.target === sharedColumns!.id,
    );
    expect(edges.length).toBe(1);
  });

  it('does not false-extract element-shaped text inside XML comments', async () => {
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <!-- TODO: also handle <select id="todoSelect">SELECT 1</select>
       and <sql id="todoFrag">cols</sql> + <include refid="ghost"/>
       and <resultMap id="todoMap" type="X"/> -->
  <select id="real">SELECT 1</select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const xmlMethods = getNodesByKind(cg.queries, 'method').filter((m) => m.language === 'xml');
    const xmlTypes = getNodesByKind(cg.queries, 'type_alias').filter((n) => n.language === 'xml');
    // Only `real` should be extracted — the four comment-shaped tags
    // (todoSelect / todoFrag / ghost / todoMap) are stripped before
    // the regex scan runs.
    expect(xmlMethods.map((m) => m.name).sort(byString)).toEqual(['real']);
    expect(xmlTypes.length).toBe(0);
  });

  // ── v2 (2026-05-27): resultMap="X" / parameterMap="X" attribute edges ──

  it('links <select resultMap="X"> to the matching <resultMap id="X"> node', async () => {
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <resultMap id="userResult" type="com.example.User">
    <id column="id" property="id"/>
    <result column="name" property="name"/>
  </resultMap>
  <select id="findById" resultMap="userResult">SELECT * FROM users WHERE id = #{id}</select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const stmt = getNodesByKind(cg.queries, 'method').find((m) => m.language === 'xml' && m.name === 'findById');
    const resultMapNode = getNodesByKind(cg.queries, 'type_alias').find(
      (n) => n.language === 'xml' && n.name === 'userResult',
    );
    expect(stmt).toBeDefined();
    expect(resultMapNode).toBeDefined();

    // The standard resolver's qualifiedName path picks up the
    // `resultMap="userResult"` attribute we emit as an unresolved ref
    // and binds it to the matching `<resultMap id="userResult">` node.
    const edges = getOutgoingEdges(cg.queries, stmt!.id).filter(
      (e) => e.kind === 'references' && e.target === resultMapNode!.id,
    );
    expect(edges.length).toBe(1);
  });

  it('links <insert parameterMap="X"> to the matching <parameterMap id="X"> node', async () => {
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <parameterMap id="userInputs" type="com.example.UserInput"/>
  <insert id="create" parameterMap="userInputs">INSERT INTO users (name) VALUES (#{name})</insert>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const stmt = getNodesByKind(cg.queries, 'method').find((m) => m.language === 'xml' && m.name === 'create');
    const parameterMapNode = getNodesByKind(cg.queries, 'type_alias').find(
      (n) => n.language === 'xml' && n.name === 'userInputs',
    );
    expect(stmt).toBeDefined();
    expect(parameterMapNode).toBeDefined();

    const edges = getOutgoingEdges(cg.queries, stmt!.id).filter(
      (e) => e.kind === 'references' && e.target === parameterMapNode!.id,
    );
    expect(edges.length).toBe(1);
  });

  it('resolves cross-mapper resultMap="OtherMapper.X" to the right type_alias', async () => {
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'OtherMapper.xml'),
      `<mapper namespace="com.example.OtherMapper">
  <resultMap id="sharedResult" type="com.example.SharedView"/>
</mapper>
`,
    );
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <select id="findShared" resultMap="com.example.OtherMapper.sharedResult">SELECT 1</select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const stmt = getNodesByKind(cg.queries, 'method').find(
      (m) => m.language === 'xml' && m.qualifiedName === 'UserMapper::findShared',
    );
    const sharedResult = getNodesByKind(cg.queries, 'type_alias').find(
      (n) => n.qualifiedName === 'OtherMapper::sharedResult',
    );
    expect(stmt).toBeDefined();
    expect(sharedResult).toBeDefined();

    const edges = getOutgoingEdges(cg.queries, stmt!.id).filter(
      (e) => e.kind === 'references' && e.target === sharedResult!.id,
    );
    expect(edges.length).toBe(1);
  });

  // ── v3 (2026-05-27): #{name} ↔ Java @Param("name") binding edges ──

  it('binds <select> body #{userId} to the Java @Param("userId") parameter node', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'UserMapper.java'),
      `package com.example;
public interface UserMapper {
  User findById(@Param("userId") long userId);
}
`,
    );
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <select id="findById">SELECT * FROM users WHERE id = #{userId}</select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    // The Java extractor's v3 pass should have emitted a parameter
    // node for `userId` with @Param decoratorArgs.
    const paramNode = getNodesByKind(cg.queries, 'parameter').find(
      (n) => n.language === 'java' && n.qualifiedName === 'UserMapper::findById::userId',
    );
    expect(paramNode, 'parameter node should exist with chained qualifiedName').toBeDefined();
    expect(paramNode!.decoratorArgs?.find((a) => a.name === 'Param')?.argStrings[0]).toBe('userId');

    // The XML extractor emitted an unresolved ref shaped as
    // `UserMapper::findById::userId`; the standard resolver binds it
    // to the parameter node above.
    const xmlStmt = getNodesByKind(cg.queries, 'method').find(
      (m) => m.language === 'xml' && m.qualifiedName === 'UserMapper::findById',
    );
    expect(xmlStmt).toBeDefined();
    const edges = getOutgoingEdges(cg.queries, xmlStmt!.id).filter(
      (e) => e.kind === 'references' && e.target === paramNode!.id,
    );
    expect(edges.length).toBe(1);
  });

  it('binds multiple #{params} in one statement to their respective parameter nodes', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'UserMapper.java'),
      `package com.example;
public interface UserMapper {
  java.util.List<User> findByName(@Param("name") String name, @Param("limit") int limit);
}
`,
    );
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <select id="findByName">SELECT * FROM users WHERE name = #{name} LIMIT #{limit}</select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const xmlStmt = getNodesByKind(cg.queries, 'method').find(
      (m) => m.language === 'xml' && m.qualifiedName === 'UserMapper::findByName',
    );
    expect(xmlStmt).toBeDefined();

    const params = getNodesByKind(cg.queries, 'parameter').filter(
      (n) => n.language === 'java' && n.qualifiedName.startsWith('UserMapper::findByName::'),
    );
    expect(params.length).toBe(2);

    // Both params should have a references edge from the XML statement.
    for (const param of params) {
      const edges = getOutgoingEdges(cg.queries, xmlStmt!.id).filter(
        (e) => e.kind === 'references' && e.target === param.id,
      );
      expect(edges.length, `XML stmt should bind to ${param.name}`).toBe(1);
    }
  });

  it('binds #{user.name} property-access to the head parameter node', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'UserMapper.java'),
      `package com.example;
public interface UserMapper {
  void update(@Param("user") User user);
}
`,
    );
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <update id="update">UPDATE users SET name = #{user.name} WHERE id = #{user.id}</update>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const xmlStmt = getNodesByKind(cg.queries, 'method').find(
      (m) => m.language === 'xml' && m.qualifiedName === 'UserMapper::update',
    );
    const userParam = getNodesByKind(cg.queries, 'parameter').find(
      (n) => n.language === 'java' && n.qualifiedName === 'UserMapper::update::user',
    );
    expect(xmlStmt).toBeDefined();
    expect(userParam).toBeDefined();

    // Both `#{user.name}` and `#{user.id}` collapse to the head
    // identifier `user`; the de-dup in the extractor ensures we
    // only emit one references edge (not two for the same param).
    const edges = getOutgoingEdges(cg.queries, xmlStmt!.id).filter(
      (e) => e.kind === 'references' && e.target === userParam!.id,
    );
    expect(edges.length).toBe(1);
  });

  it('binds #{paramName,jdbcType=VARCHAR} type-hint syntax to the parameter node', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'UserMapper.java'),
      `package com.example;
public interface UserMapper {
  User findByCode(@Param("code") String code);
}
`,
    );
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <select id="findByCode">SELECT * FROM users WHERE code = #{code,jdbcType=VARCHAR}</select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const codeParam = getNodesByKind(cg.queries, 'parameter').find(
      (n) => n.language === 'java' && n.qualifiedName === 'UserMapper::findByCode::code',
    );
    const stmt = getNodesByKind(cg.queries, 'method').find(
      (m) => m.language === 'xml' && m.qualifiedName === 'UserMapper::findByCode',
    );
    expect(codeParam).toBeDefined();
    expect(stmt).toBeDefined();

    // The type-hint suffix `,jdbcType=VARCHAR` must NOT prevent the
    // bind — PARAM_BIND_RE's trailing `(?:,[^}]*)?` skips it without
    // capturing it into the param-name group.
    const edges = getOutgoingEdges(cg.queries, stmt!.id).filter(
      (e) => e.kind === 'references' && e.target === codeParam!.id,
    );
    expect(edges.length).toBe(1);
  });

  it('does NOT bind ${literal} string-substitution placeholders', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'UserMapper.java'),
      `package com.example;
public interface UserMapper {
  User findOrdered(@Param("orderBy") String orderBy);
}
`,
    );
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <select id="findOrdered">SELECT * FROM users ORDER BY \${orderBy}</select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const orderByParam = getNodesByKind(cg.queries, 'parameter').find(
      (n) => n.language === 'java' && n.qualifiedName === 'UserMapper::findOrdered::orderBy',
    );
    const stmt = getNodesByKind(cg.queries, 'method').find(
      (m) => m.language === 'xml' && m.qualifiedName === 'UserMapper::findOrdered',
    );
    expect(orderByParam).toBeDefined();
    expect(stmt).toBeDefined();

    // \${orderBy} is MyBatis string substitution (NOT parameter
    // binding) — deliberately not scanned by PARAM_BIND_RE. The
    // statement should have NO references edge to the orderBy param.
    const edges = getOutgoingEdges(cg.queries, stmt!.id).filter(
      (e) => e.kind === 'references' && e.target === orderByParam!.id,
    );
    expect(edges.length).toBe(0);
  });

  // ── v3.1 (2026-05-27): Kotlin parameter-annotation support ──

  it('emits Kotlin parameter nodes with @Param decoratorArgs and chained qualifiedName', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'UserMapper.kt'),
      `interface UserMapper {
  fun findById(@Param("userId") userId: Long): User
  fun findByName(@Param("name") name: String, @Param("limit") limit: Int): List<User>
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const params = getNodesByKind(cg.queries, 'parameter').filter((n) => n.language === 'kotlin');
    const qns = params.map((p) => p.qualifiedName).sort(byString);
    expect(qns).toEqual([
      'UserMapper::findById::userId',
      'UserMapper::findByName::limit',
      'UserMapper::findByName::name',
    ]);

    // Each param has its @Param decoratorArgs populated.
    for (const p of params) {
      const paramEntry = p.decoratorArgs?.find((a) => a.name === 'Param');
      expect(paramEntry, `${p.qualifiedName} should have @Param decoratorArgs`).toBeDefined();
      expect(paramEntry!.argStrings[0]).toBe(p.name);
    }
  });

  it('binds Kotlin Mapper #{param} from XML to the matching Kotlin parameter node', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'UserMapper.kt'),
      `interface UserMapper {
  fun findById(@Param("userId") userId: Long): User
}
`,
    );
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <select id="findById">SELECT * FROM users WHERE id = #{userId}</select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const paramNode = getNodesByKind(cg.queries, 'parameter').find(
      (n) => n.language === 'kotlin' && n.qualifiedName === 'UserMapper::findById::userId',
    );
    const xmlStmt = getNodesByKind(cg.queries, 'method').find(
      (m) => m.language === 'xml' && m.qualifiedName === 'UserMapper::findById',
    );
    expect(paramNode, 'Kotlin parameter node should exist').toBeDefined();
    expect(xmlStmt).toBeDefined();

    // The XML statement's `#{userId}` ref binds to the Kotlin
    // parameter via the standard resolver's qn-match — same path
    // as the Java equivalent, just a different source language.
    const edges = getOutgoingEdges(cg.queries, xmlStmt!.id).filter(
      (e) => e.kind === 'references' && e.target === paramNode!.id,
    );
    expect(edges.length).toBe(1);
  });

  it('handles mixed annotated + un-annotated Kotlin params without misalignment', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'AuditMapper.kt'),
      `interface AuditMapper {
  fun create(plainParam: User, @Param("audit") audit: String)
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    // Only the annotated param gets a node; the plain `plainParam`
    // (no annotation) is correctly skipped. The state-machine pairing
    // of parameter_modifiers→parameter must not slip when an
    // un-annotated param sits BEFORE an annotated one.
    const params = getNodesByKind(cg.queries, 'parameter').filter((n) => n.language === 'kotlin');
    expect(params.length).toBe(1);
    expect(params[0]!.name).toBe('audit');
    expect(params[0]!.qualifiedName).toBe('AuditMapper::create::audit');
  });

  it('does NOT emit a parameter node for un-annotated Java params', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'PlainMapper.java'),
      `package com.example;
public interface PlainMapper {
  int countByPrefix(String prefix);
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    // The `prefix` param has no annotation — the "has annotation" gate
    // in tsEmitAnnotatedParameters means no parameter node is emitted.
    // This is the graph-footprint guard.
    const params = getNodesByKind(cg.queries, 'parameter').filter((n) => n.language === 'java');
    expect(params.length).toBe(0);
  });

  // ── v4 (2026-05-27): mybatis-config.xml extraction ──

  it('extracts <mapper class="X"/> from mybatis-config.xml as references to the Java interface', async () => {
    // Java mapper interfaces (the resolution targets).
    fs.writeFileSync(
      path.join(tempDir, 'UserMapper.java'),
      `package com.example;
public interface UserMapper {
  User findById(@Param("id") long id);
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'OrderMapper.java'),
      `package com.example;
public interface OrderMapper {
  Object findOne();
}
`,
    );
    // mybatis-config.xml — at the conventional src/main/resources path
    // so the narrow include glob matches.
    const resourcesDir = path.join(tempDir, 'src', 'main', 'resources');
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(
      path.join(resourcesDir, 'mybatis-config.xml'),
      `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE configuration PUBLIC "-//mybatis.org//DTD Config 3.0//EN" "http://mybatis.org/dtd/mybatis-3-config.dtd">
<configuration>
  <mappers>
    <mapper class="com.example.UserMapper"/>
    <mapper class="com.example.OrderMapper"/>
  </mappers>
</configuration>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const configFile = cg.queries.db
      .prepare(`SELECT id FROM nodes WHERE kind = 'file' AND name = 'mybatis-config.xml'`)
      .get() as { id: string } | undefined;
    expect(configFile, 'mybatis-config.xml file node should exist').toBeDefined();

    const userMapper = getNodesByKind(cg.queries, 'interface').find(
      (n) => n.language === 'java' && n.name === 'UserMapper',
    );
    const orderMapper = getNodesByKind(cg.queries, 'interface').find(
      (n) => n.language === 'java' && n.name === 'OrderMapper',
    );
    expect(userMapper).toBeDefined();
    expect(orderMapper).toBeDefined();

    // The config file should have references edges to each declared Mapper.
    const userEdges = getOutgoingEdges(cg.queries, configFile!.id).filter(
      (e) => e.kind === 'references' && e.target === userMapper!.id,
    );
    const orderEdges = getOutgoingEdges(cg.queries, configFile!.id).filter(
      (e) => e.kind === 'references' && e.target === orderMapper!.id,
    );
    expect(userEdges.length).toBe(1);
    expect(orderEdges.length).toBe(1);
  });

  it('extracts <typeAlias> from mybatis-config.xml as type_alias nodes', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'User.java'),
      `package com.example;
public class User {}
`,
    );
    const resourcesDir = path.join(tempDir, 'src', 'main', 'resources');
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(
      path.join(resourcesDir, 'mybatis-config.xml'),
      `<configuration>
  <typeAliases>
    <typeAlias alias="User" type="com.example.User"/>
    <typeAlias alias="StringMap" type="java.util.Map"/>
  </typeAliases>
  <mappers>
    <mapper class="com.example.Whatever"/>
  </mappers>
</configuration>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const aliases = getNodesByKind(cg.queries, 'type_alias').filter((n) => n.language === 'xml' && n.name !== '');
    const userAlias = aliases.find((n) => n.name === 'User');
    const stringMapAlias = aliases.find((n) => n.name === 'StringMap');
    expect(userAlias).toBeDefined();
    expect(stringMapAlias).toBeDefined();

    // Signature carries the declared FQCN even when the target isn't
    // a project-local class (stdlib `java.util.Map`). The FQCN in
    // signature is intentional — v4 deliberately does NOT emit a
    // type_of edge to the target class because the common shape
    // `<typeAlias alias="User" type="com.example.User"/>` has the
    // alias + target sharing a simple name, which makes the
    // resolver's name-match path race itself. The signature carries
    // the full linkage info needed by tooling.
    expect(userAlias!.signature).toBe('com.example.User');
    expect(stringMapAlias!.signature).toBe('java.util.Map');
  });

  it('does NOT trigger config-file extraction on a plain <configuration> file (Maven pom.xml etc.)', async () => {
    // The config-file gate requires `<configuration>` AND `<mappers>`
    // joint presence. Maven `pom.xml` has the former but not the
    // latter. Putting it under a mapper-convention path so the
    // include glob would let it through if the gate were broken.
    const mapperDir = path.join(tempDir, 'src', 'main', 'resources', 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'pom.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <configuration>
    <source>17</source>
    <target>17</target>
  </configuration>
</project>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    // Should emit ZERO graph nodes for this file (the file row
    // is still tracked in `files`, but no symbols / refs come out).
    const xmlNodes = cg.queries.db.prepare(`SELECT * FROM nodes WHERE language = 'xml'`).all();
    expect(xmlNodes.length).toBe(0);
  });

  it('emits no references edge when the resultMap attribute names nothing real', async () => {
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <select id="findById" resultMap="ghost">SELECT 1</select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const stmt = getNodesByKind(cg.queries, 'method').find((m) => m.language === 'xml' && m.name === 'findById');
    expect(stmt).toBeDefined();

    // No matching `<resultMap id="ghost">` exists; the standard
    // resolver leaves the ref unresolved (mirrors the include-refid
    // negative test below). Belt-and-braces guard on the v2
    // resultMap-attribute code path.
    const refEdges = getOutgoingEdges(cg.queries, stmt!.id).filter((e) => e.kind === 'references');
    expect(refEdges.length).toBe(0);
  });

  it('emits no references edge when the refid points at nothing', async () => {
    const mapperDir = path.join(tempDir, 'mapper');
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapperDir, 'UserMapper.xml'),
      `<mapper namespace="com.example.UserMapper">
  <select id="findById" resultType="User">
    SELECT <include refid="nonexistent"/> FROM users WHERE id = #{id}
  </select>
</mapper>
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const findByIdStmt = getNodesByKind(cg.queries, 'method').find(
      (m) => m.language === 'xml' && m.name === 'findById',
    );
    expect(findByIdStmt).toBeDefined();

    // No matching `<sql id="nonexistent">` exists; the standard
    // resolver leaves the ref unresolved (no `references` edge from
    // findById to any node — only the inbound `contains` from file).
    const refEdges = getOutgoingEdges(cg.queries, findByIdStmt!.id).filter((e) => e.kind === 'references');
    expect(refEdges.length).toBe(0);
  });
});
