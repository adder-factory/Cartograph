/* C test bed */
#include <stdio.h>
#include "helper.h"

#define MAX_ITEMS 100

typedef struct Box {
    char* value;
} Box;

typedef struct Container {
    Box* items;
    int count;
} Container;

void add(Container* c, Box item) {
    c->items[c->count++] = item;
}

int size(Container* c) {
    return c->count;
}

Container* process(Box input) {
    Container* c = (Container*)malloc(sizeof(Container));
    add(c, input);
    helper_log(c);
    return c;
}

const int FOO = 42;
