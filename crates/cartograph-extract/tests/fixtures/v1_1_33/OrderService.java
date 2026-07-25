package com.acme.orders;

import java.util.List;
import static java.util.Collections.emptyList;
import java.time.*;

@Deprecated
public class OrderService extends BaseService implements Closeable, Auditable {
    private final Repository repository;
    public static final String KIND = "sk_live_java_secret";

    /** Creates the service. */
    public OrderService(Repository repository) {
        this.repository = repository;
    }

    @Override
    public List<Order> find(String id) {
        Order result = new Order(id);
        repository.findById(id);
        this.repository.findById(id);
        return result;
    }

    public static int add(int left, int right) {
        return left + right;
    }
}
