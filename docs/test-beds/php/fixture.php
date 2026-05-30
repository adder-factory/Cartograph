<?php
// PHP test bed
namespace TestBed;

require_once 'helper.php';

class Box {
    public $value;
    public function __construct($value) { $this->value = $value; }
}

class Container {
    private array $items = [];
    public function add(Box $item): void { $this->items[] = $item; }
    public function size(): int { return count($this->items); }
}

function process(Box $input): Container {
    $c = new Container();
    $c->add($input);
    Helper::log($c);
    return $c;
}

const FOO = 42;
