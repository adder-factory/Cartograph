import { describe, expect, it } from 'vitest';
import { springResolver } from '../src/resolution/frameworks/java.js';
import { laravelResolver } from '../src/resolution/frameworks/laravel.js';
import { railsResolver } from '../src/resolution/frameworks/ruby.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';
import type { Language, Node, NodeKind } from '../src/types.js';

function node(id: string, name: string, kind: NodeKind, filePath: string, language: Language): Node {
  return {
    id,
    name,
    kind,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: name.length,
  };
}

function ref(referenceName: string, language: Language): UnresolvedRef {
  return {
    fromNodeId: 'source',
    referenceName,
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath: language === 'ruby' ? 'app/controllers/orders_controller.rb' : 'src/main/java/App.java',
    language,
  };
}

function context(files: Record<string, string>, nodes: Node[] = []): ResolutionContext {
  return {
    getNodesInFile: (filePath: string) => nodes.filter((n) => n.filePath === filePath),
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: (qualifiedName: string) => nodes.filter((n) => n.qualifiedName === qualifiedName),
    getNodesByKind: (kind: NodeKind) => nodes.filter((n) => n.kind === kind),
    fileExists: (filePath: string) => Object.hasOwn(files, filePath),
    readFile: (filePath: string) => files[filePath] ?? null,
    getProjectRoot: () => '/tmp/framework-project',
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: (lowerName: string) => nodes.filter((n) => n.name.toLowerCase() === lowerName),
    getImportMappings: (_filePath: string, _language: Language) => [],
  };
}

describe('Ruby and Java framework resolvers', () => {
  it('detects Rails and Spring projects from real framework signals', () => {
    expect(railsResolver.detect(context({ Gemfile: "gem 'rails'\n" }))).toBe(true);
    expect(
      railsResolver.detect(
        context({ 'config/application.rb': 'module Shop\nclass Application < Rails::Application\nend' }),
      ),
    ).toBe(true);
    expect(
      railsResolver.detect(context({ 'app/controllers/application_controller.rb': 'class ApplicationController' })),
    ).toBe(true);

    expect(springResolver.detect(context({ 'pom.xml': '<artifactId>spring-boot-starter-web</artifactId>' }))).toBe(
      true,
    );
    expect(
      springResolver.detect(context({ 'build.gradle.kts': 'implementation("org.springframework.boot:spring-boot")' })),
    ).toBe(true);
    expect(
      springResolver.detect(
        context({
          'src/main/java/com/acme/App.java': '@SpringBootApplication class App {}\n@RestController class Api {}',
        }),
      ),
    ).toBe(true);
  });

  it('extracts Rails routes, Rails controller actions, and Spring mapping routes', () => {
    const railsRoutes = railsResolver.extractNodes!(
      'config/routes.rb',
      ['Rails.application.routes.draw do', '  root "home#index"', '  resources :orders', '  post "/login"'].join('\n'),
    );
    expect(railsRoutes.map((n) => n.name)).toEqual(['/ -> home#index', 'resource:orders', 'POST /login']);

    const actions = railsResolver.extractNodes!(
      'app/controllers/orders_controller.rb',
      [
        'class OrdersController < ApplicationController',
        '  def index',
        '  end',
        '  def set_order',
        '  end',
        'end',
      ].join('\n'),
    );
    expect(actions.map((n) => n.name)).toEqual(['index']);

    const springRoutes = springResolver.extractNodes!(
      'src/main/java/com/acme/OrdersController.java',
      [
        '@RequestMapping("/api")',
        'class OrdersController {',
        '  @GetMapping("/orders")',
        '  List<Order> index() {}',
        '  @PostMapping(path = "/orders")',
        '  Order create() {}',
        '}',
      ].join('\n'),
    );
    expect(springRoutes.map((n) => n.name)).toEqual(['GET /orders', 'POST /orders', 'BASE /api']);
  });

  it('resolves Rails models, controllers, helpers, services, and jobs by convention', () => {
    const nodes = [
      node('model', 'OrderItem', 'class', 'app/models/order_item.rb', 'ruby'),
      node('concern', 'Auditable', 'class', 'app/models/concerns/auditable.rb', 'ruby'),
      node('controller', 'ApiOrdersController', 'class', 'app/controllers/api/api_orders_controller.rb', 'ruby'),
      node('helper', 'OrdersHelper', 'module', 'app/helpers/orders_helper.rb', 'ruby'),
      node('service', 'CheckoutService', 'class', 'app/services/checkout_service.rb', 'ruby'),
      node('job', 'InvoiceJob', 'class', 'app/jobs/invoice_job.rb', 'ruby'),
    ];
    const ctx = context(
      {
        'app/models/order_item.rb': '',
        'app/models/concerns/auditable.rb': '',
        'app/controllers/api/api_orders_controller.rb': '',
        'app/helpers/orders_helper.rb': '',
        'app/services/checkout_service.rb': '',
        'app/jobs/invoice_job.rb': '',
      },
      nodes,
    );

    expect(railsResolver.resolve(ref('OrderItem', 'ruby'), ctx)).toMatchObject({
      targetNodeId: 'model',
      confidence: 0.8,
    });
    expect(railsResolver.resolve(ref('Auditable', 'ruby'), ctx)).toMatchObject({ targetNodeId: 'concern' });
    expect(railsResolver.resolve(ref('ApiOrdersController', 'ruby'), ctx)).toMatchObject({
      targetNodeId: 'controller',
      confidence: 0.85,
    });
    expect(railsResolver.resolve(ref('OrdersHelper', 'ruby'), ctx)).toMatchObject({ targetNodeId: 'helper' });
    expect(railsResolver.resolve(ref('CheckoutService', 'ruby'), ctx)).toMatchObject({ targetNodeId: 'service' });
    expect(railsResolver.resolve(ref('InvoiceJob', 'ruby'), ctx)).toMatchObject({ targetNodeId: 'job' });
  });

  it('resolves Spring services, repositories, controllers, entities, and config classes by preferred package', () => {
    const nodes = [
      node('plain-service', 'BillingService', 'class', 'src/main/java/com/acme/BillingService.java', 'java'),
      node('service', 'BillingService', 'class', 'src/main/java/com/acme/service/BillingService.java', 'java'),
      node('repo', 'OrderRepository', 'interface', 'src/main/java/com/acme/repository/OrderRepository.java', 'java'),
      node(
        'controller',
        'OrdersController',
        'class',
        'src/main/java/com/acme/controllers/OrdersController.java',
        'java',
      ),
      node('entity', 'Order', 'class', 'src/main/java/com/acme/domain/Order.java', 'java'),
      node('config', 'WebConfig', 'class', 'src/main/java/com/acme/config/WebConfig.java', 'java'),
    ];
    const ctx = context({}, nodes);

    expect(springResolver.resolve(ref('BillingService', 'java'), ctx)).toMatchObject({
      targetNodeId: 'service',
      confidence: 0.85,
    });
    expect(springResolver.resolve(ref('OrderRepository', 'java'), ctx)).toMatchObject({ targetNodeId: 'repo' });
    expect(springResolver.resolve(ref('OrdersController', 'java'), ctx)).toMatchObject({ targetNodeId: 'controller' });
    expect(springResolver.resolve(ref('Order', 'java'), ctx)).toMatchObject({
      targetNodeId: 'entity',
      confidence: 0.7,
    });
    expect(springResolver.resolve(ref('WebConfig', 'java'), ctx)).toMatchObject({
      targetNodeId: 'config',
      confidence: 0.8,
    });
  });

  it('extracts Laravel routes and resolves Laravel model/controller references by convention', () => {
    const routes = laravelResolver.extractNodes!(
      'routes/web.php',
      [
        '<?php',
        "Route::get('/orders', [OrderController::class, 'index']);",
        "Route::resource('users', UserController::class);",
        "Route::apiResource('teams', TeamController::class);",
      ].join('\n'),
    );
    expect(routes.map((n) => n.name)).toEqual(['GET /orders', 'resource:users', 'resource:teams']);

    const nodes = [
      node('method', 'active', 'method', 'app/Models/User.php', 'php'),
      node('model', 'LegacyOrder', 'class', 'app/LegacyOrder.php', 'php'),
      node('controller-method', 'index', 'method', 'app/Http/Controllers/OrderController.php', 'php'),
      node(
        'namespaced-controller',
        'AdminUserController',
        'class',
        'app/Http/Controllers/Admin/UserController.php',
        'php',
      ),
      node('namespaced-method', 'show', 'method', 'app/Http/Controllers/Admin/UserController.php', 'php'),
    ];
    const ctx = context(
      {
        'app/Models/User.php': '',
        'app/LegacyOrder.php': '',
        'app/Http/Controllers/OrderController.php': '',
      },
      nodes,
    );

    expect(laravelResolver.resolve(ref('User::active', 'php'), ctx)).toMatchObject({
      targetNodeId: 'method',
      confidence: 0.85,
    });
    expect(laravelResolver.resolve(ref('LegacyOrder::query', 'php'), ctx)).toMatchObject({ targetNodeId: 'model' });
    expect(laravelResolver.resolve(ref('OrderController@index', 'php'), ctx)).toMatchObject({
      targetNodeId: 'controller-method',
      confidence: 0.9,
    });
    expect(laravelResolver.resolve(ref('AdminUserController@show', 'php'), ctx)).toMatchObject({
      targetNodeId: 'namespaced-method',
    });
    expect(laravelResolver.resolve(ref('Auth::user', 'php'), ctx)).toBeNull();
    expect(laravelResolver.resolve(ref('route', 'php'), ctx)).toBeNull();
  });
});
