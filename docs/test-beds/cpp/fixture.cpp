// C++ test bed
#include <vector>
#include <string>
#include "helper.h"

#define MAX_ITEMS 100

template<typename T>
class Box {
public:
    T value;
    Box(T v) : value(v) {}
};

template<typename T>
class Container {
    std::vector<Box<T>> items;
public:
    void add(Box<T> item) { items.push_back(item); }
    int size() const { return items.size(); }
};

Container<std::string>* process(Box<std::string> input) {
    auto* c = new Container<std::string>();
    c->add(input);
    Helper::log(c);
    return c;
}

const int FOO = 42;
